---
title: Why I Moved My Deploy Pipeline Off GitHub-Hosted Runners
publishDate: 2026-05-30 00:00:00
img: /assets/blog/self-hosted-runner.webp
img_alt: A GitHub server on the left connected by an arrow to a secured private server on the right with a shield, representing a CI/CD pipeline moving from GitHub-hosted to self-hosted infrastructure
description: |
  The standard approach to deploying from GitHub Actions is to SSH into your server from the workflow. That means storing a private key in GitHub Secrets. Here's a different model — a self-hosted runner that connects outbound to GitHub, with no inbound SSH and no credentials stored in GitHub at all.
tags:
  - GitHub Actions
  - CI/CD
  - DevSecOps
  - Docker
  - GHCR
---

## TL;DR

A self-hosted runner lives on the server and connects outbound to GitHub — not the other way around. No SSH private key in GitHub Secrets, no inbound firewall rules for GitHub to reach, no IP whitelist to maintain. The deploy job runs locally on the machine it's deploying to. A GitHub-hosted runner handles the Docker build separately, since the server only has 1GB RAM and can't do it itself.

---

## The Standard Approach and Its Problem

The most common way to deploy from GitHub Actions is: a GitHub-hosted runner SSHs into your server, pulls the latest code or image, and restarts the containers. It works, and for many projects it's the right call.

The cost is that your SSH private key lives in GitHub Secrets. If those secrets are ever exposed — a misconfigured workflow, a compromised token, a supply chain issue in a third-party action — an attacker has direct shell access to your server. The attack surface exists even if the probability is low.

There's also an operational overhead: GitHub's IP range for Actions runners is large and changes frequently, so whitelisting inbound SSH to GitHub IPs is more maintenance than it's worth. Most people leave port 22 open to the world and accept the private key as the only security boundary. That's a reasonable position for a hobby project, but it's not the posture you'd choose if you had an alternative.

---

## The Alternative: Runner on the Server

A self-hosted runner is a process you install on your own infrastructure. It connects outbound to GitHub over HTTPS, polls for jobs, and executes them locally. The connection direction is reversed — GitHub never reaches into your server, your server reaches out to GitHub.

The security properties follow from that:

- No SSH private key stored in GitHub Secrets;
- No inbound firewall rules required for CI/CD;
- No IP whitelist to maintain;
- The deploy job runs with whatever permissions the local user has — no credential passing required.

For my [instance-starter project](https://github.com/leighwest/instance-starter), the runner runs as the `deployer` user on the Vultr VPS. When a deploy job fires, it executes directly on the server with access to Docker Compose and the local filesystem. There is nothing for GitHub to authenticate against from the outside.

---

## The Two-Job Pipeline

The workflow splits into two jobs for a practical reason.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v5

      - name: Log in to GHCR
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v7
        with:
          context: .
          file: ./docker/Dockerfile.web
          push: true
          tags: ghcr.io/leighwest/instance-starter:latest

  deploy:
    runs-on: self-hosted
    needs: build
    steps:
      - name: Deploy to server
        run: |
          set -e
          cd /home/deployer/instance-starter
          docker-compose -f docker-compose.yaml pull
          docker-compose -f docker-compose.yaml down
          docker-compose -f docker-compose.yaml up -d
          docker-compose -f docker-compose.yaml exec -T web python manage.py migrate
          docker-compose -f docker-compose.yaml exec -T web python manage.py collectstatic --noinput
          docker-compose -f docker-compose.yaml exec -T web python manage.py sync_instances
      - name: Clean up Docker images
        run: docker image prune -a -f
```

The build job runs on a GitHub-hosted runner (`ubuntu-latest`) with 16GB RAM. The deploy job runs on the self-hosted runner on the Vultr VPS with 1GB RAM. The split exists because a Docker build on a 1GB instance routinely ran out of memory — the build was OOM-killed before it completed. Moving the build to GitHub's infrastructure solved it cleanly: the server only ever pulls a finished image, never builds one.

The two jobs have different authentication requirements, which is worth understanding.

**The build job** uses `secrets.GITHUB_TOKEN` to push to GHCR. This is a short-lived token that GitHub injects automatically into every workflow run — no configuration required, no token to manage, no rotation needed. It exists only for the duration of the run.

**The deploy job** runs on the server, which needs to pull from GHCR independently of any workflow run. `GITHUB_TOKEN` can't be reused here — it's scoped to the workflow that generated it. The server needs its own credentials: a classic personal access token with `read:packages` scope, stored on the server and used for `docker login`. Fine-grained tokens were the obvious first choice; they turned out not to support `read:packages` for GHCR, which isn't documented prominently and took a failed login to discover.

---

## `-f docker-compose.yaml` Everywhere

One non-obvious issue: Docker Compose automatically merges any file named `docker-compose.override.yml` with the base compose file. This is useful for local development — my override file replaces the GHCR image reference with a local build so I can iterate without pushing to the registry. On the server, it causes the deploy to try to build an image that doesn't exist there.

The fix is to be explicit about which file to use in every `docker-compose` call in the workflow and in cloud-init:

```bash
docker-compose -f docker-compose.yaml pull
docker-compose -f docker-compose.yaml down
docker-compose -f docker-compose.yaml up -d
```

The override file stays in source control and works correctly for local development. The server ignores it because the file flag is always explicit.

---

## Runner Registration

Installing the runner is mechanical — download the archive, extract it, configure it against the repository. The configuration step requires a short-lived registration token, which you fetch from the GitHub API:

```bash
REG_TOKEN=$(curl -s -X POST \
  -H "Authorization: token ${github_runner_pat}" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/leighwest/instance-starter/actions/runners/registration-token \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])")

./config.sh \
  --url https://github.com/leighwest/instance-starter \
  --token $REG_TOKEN \
  --unattended \
  --name instance-starter-runner \
  --labels self-hosted \
  --replace
```

`--replace` is important: without it, reprovisioning fails because a runner with the same name already exists in GitHub from the previous provision. With it, the old registration is replaced cleanly.

A note on the token parsing: the initial implementation used `grep` to extract the token from the API response. That's fragile — JSON formatting changes silently break it. `python3 -c "import sys, json; print(json.load(sys.stdin)['token'])"` is more robust and available on any modern Ubuntu instance without extra dependencies.

Once configured, the runner installs as a systemd service and starts automatically:

```bash
cd /home/deployer/actions-runner
./svc.sh install deployer
./svc.sh start
```

It survives reboots and reconnects to GitHub automatically. The `deployer` user doesn't need elevated permissions for this — the service runs under that user account.

---

## The Manual-to-Automated Arc

Initially, runner registration was a manual step after each `terraform apply`. SSH in, download the archive, call the GitHub API, run `config.sh`, install the service. Too many steps and the registration token expires after an hour so there was a narrow window to complete it.

The correct fix is to automate it in cloud-init — the same script that provisions everything else. The GitHub API call uses a long-lived PAT with `repo` scope injected via Terraform's `templatefile()`, so cloud-init can fetch a fresh registration token at boot time regardless of when provisioning happens. GHCR authentication is handled the same way: the `read:packages` PAT is injected at provision time and `docker login` runs automatically before the first image pull.

The result is that a `terraform apply` produces a fully operational server — runner registered, GHCR authenticated, CI/CD working — without any post-provisioning manual steps.

---

## Testing Without Breaking Production

Cloud-init only runs on first boot. The only real test of a change is a fresh provision. The live server was running and needed to stay up during job applications, so tearing it down to test a cloud-init change wasn't an option.

The solution was a Terraform workspace:

```bash
terraform workspace new test
terraform apply -var-file="terraform.tfvars.test"
```

A workspace creates isolated state — the test provision creates its own Vultr instance, reserved IP, and firewall group without touching the default workspace's resources. `terraform.tfvars.test` points at a dummy domain and skips Certbot, since the test instance has no DNS record. Once the cloud-init changes were validated — runner registered, GHCR login working, containers up — the test workspace was destroyed and the changes were applied to the live server on the next reprovision.

The live server was never at risk. The test cost a few cents in Vultr compute time.

---

## Known Issue

One rough edge remains: the reserved IP detach issue on `terraform destroy`. Vultr's API errors when attempting to detach a reserved IP from an instance that's already been deleted. The workaround is to delete the reserved IP manually in the Vultr dashboard, remove it from Terraform state, and re-apply. It's a known Vultr provider issue rather than anything in the architecture.

---

## GitHub Secrets

The workflow requires no secrets configured in GitHub at all. `GITHUB_TOKEN` — used by the build job to push to GHCR — is injected automatically by GitHub into every workflow run. It requires no setup, no rotation, and no storage in Secrets.

Everything else — GHCR pull auth, Django secrets, database credentials — lives on the server, injected at provision time via Terraform. GitHub never sees them.

> _The infrastructure for this project is in [instance-starter-infra](https://github.com/leighwest/instance-starter-infra). The zero-touch provisioning setup that underpins this pipeline is covered in the [companion post](/blog/zero-touch-provisioning)._