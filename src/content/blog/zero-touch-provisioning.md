---
title: Zero-Touch Server Provisioning with Terraform and cloud-init
publishDate: 2026-05-24 00:00:00
img: /assets/blog/zero-touch-provisioning.webp
img_alt: A Terraform logo and a cloud-init configuration file connected by an arrow to a provisioned server
description: |
  One terraform apply takes me from nothing to a running, SSL-secured Django app with no manual SSH at any point. Here's how Terraform renders a cloud-init template — and the handful of things that bit me along the way.
tags:
  - Terraform
  - cloud-init
  - IaC
  - Vultr
  - Nginx
---

## TL;DR

A single `terraform apply` provisions a Vultr VPS, installs Docker and Nginx, clones the app, runs migrations, creates the admin user, and obtains a Let's Encrypt certificate — with no manual SSH at any point. Terraform renders a `cloud-init` file with `templatefile()`; the Nginx config lives in its own file and is stitched in with `indent()`; and a reserved IP resolves a chicken-and-egg problem with Django's `ALLOWED_HOSTS`.

---

## The Goal

My [instance-starter project](https://github.com/leighwest/instance-starter) is a Django app for starting and stopping AWS EC2 instances from a web UI — WebSockets for live status, Celery for the background polling. It runs as a set of Docker containers on a $5/month Vultr VPS in Melbourne.

The app itself isn't the interesting part. What I wanted was the ability to destroy the entire server and recreate it, byte-identical, from one command — no runbook, no SSH session, no "now click this in the dashboard" step. If provisioning isn't reproducible, it isn't really infrastructure as code; it's a script you run once and then quietly maintain by hand.

Two tools do the work. Terraform creates the Vultr resources — the instance, a firewall group, a reserved IP. `cloud-init` runs on the server at first boot and does everything else: installs packages, writes config, starts the app. The glue between them is a single rendered template.

---

## One Template, Rendered by Terraform

`cloud-init` reads a YAML file on first boot and executes it — install these packages, create this user, write these files, run these commands. The catch is that the file needs values Terraform owns: database passwords, the Django secret key, the server's own IP address.

Terraform's `templatefile()` function bridges that. It reads a file, substitutes `${...}` placeholders with values, and returns the result as a string. That string becomes the instance's `user_data`:

```hcl
resource "vultr_instance" "instance_starter" {
  plan              = "vc2-1c-1gb"
  region            = data.vultr_region.melbourne.id
  reserved_ip_id    = vultr_reserved_ip.main.id
  firewall_group_id = vultr_firewall_group.main.id

  user_data = templatefile("${path.module}/cloud-init.yml", {
    db_password          = var.db_password
    django_secret_key    = var.django_secret_key
    django_allowed_hosts = "${vultr_reserved_ip.main.subnet},${var.domain},localhost,127.0.0.1"
    nginx_config         = local.nginx_config
    domain               = var.domain
    certbot_email        = var.certbot_email
    # ...the rest of the values
  })

  lifecycle {
    ignore_changes = [user_data]
  }
}
```

Without `ignore_changes`, Terraform would treat a change to `user_data` as requiring a destroy and recreate of the instance. That would take down a live server to apply a change that cloud-init would never execute anyway — it only runs once, at first boot.

The `cloud-init.yml` file is mostly ordinary YAML with placeholders where Terraform's values go:

```yaml
write_files:
  - path: /tmp/app.env
    permissions: '0600'
    content: |
      DATABASE_PASSWORD=${db_password}
      DJANGO_SECRET_KEY=${django_secret_key}
      ALLOWED_HOSTS=${django_allowed_hosts}
      DEBUG=False
      # ...
```

That's the pattern at a high level. The rest of this post covers the parts that weren't obvious — the Nginx config embedding problem, the reserved IP approach, and how `cloud-init` ordering constraints shape what you can and can't do.

---

## The Nginx Config Problem

The app sits behind Nginx as a reverse proxy. Nginx needs a config file, and the obvious move is to write it inline in the `cloud-init` YAML under `write_files`.

That's easier said than done though. An Nginx config has its own indentation — `location` blocks nested inside `server` blocks — and pasting it inside a YAML block scalar means maintaining two independent indentation schemes in the same file. It's fragile because no tool treats it as the Nginx config it actually is.

So the config stays in its own file, `nginx/instance-starter.conf`, where it's a real, lintable `.conf` file. Terraform reads it and hands it to the template:

```hcl
locals {
  nginx_config = indent(6, file("${path.module}/../nginx/instance-starter.conf"))
}
```

`file()` reads the config as a string. `indent(6, ...)` is the part that matters. In the `cloud-init` file the placeholder sits six spaces deep, inside a block scalar:

```yaml
- path: /etc/nginx/sites-available/instance-starter
  owner: root:root
  permissions: '0644'
  content: |
    ${nginx_config}
```

When `templatefile()` substitutes a multi-line string, only the _first_ line inherits the six spaces in front of `${nginx_config}`. Every line after it gets inserted starting at column zero. A YAML block scalar requires every line to be indented to at least the block's base — six spaces in this case — so the second line of the Nginx config starting at column zero breaks the parse.

`indent(6, ...)` prepends six spaces to every line except the first — exactly the lines that need it. The YAML parses, and the Nginx config is written to the server exactly as authored.

---

## write_files Runs Before Your Users Do

`cloud-init` has phases, and they don't run in the order they appear in the file. `write_files` runs early. `runcmd` runs near the end. The `users` block — where I create the `deployer` user the whole app runs as — is processed _after_ `write_files`.

That ordering caused a real failure. I wanted to drop the deploy key straight into `deployer`'s home directory:

```yaml
- path: /home/deployer/.ssh/authorized_keys
  permissions: '0600'
  content: |
    ${deployer_ssh_public_key}
```

The instinct is to add `owner: deployer:deployer` to that entry. But do this and provisioning fails: when `write_files` runs, the `deployer` user doesn't exist yet, so there's no one to assign the file to.

The fix is to write the file with no `owner:` at all and fix ownership later in `runcmd`, which runs long after the user has been created:

```yaml
- mv /tmp/app.env /home/deployer/instance-starter/.env
- chown deployer:deployer /home/deployer/instance-starter/.env
- chown -R deployer:deployer /home/deployer/.ssh
```

If you're wondering why the Nginx config a few lines up gets away with `owner: root:root` — `root` exists from the very first instruction. The phase ordering only bites you for users you create yourself. Anything written for `deployer` gets written as root and chowned afterwards; the `.env` file follows the same pattern via `/tmp`.

## The Reserved IP Solves a Chicken-and-Egg Problem

Django's `ALLOWED_HOSTS` setting is a security control; it's the list of `Host` headers the app will answer to. The server's own public IP has to be on that list, or every request gets rejected.

`ALLOWED_HOSTS` goes into the `.env` file. The `.env` file is rendered into `user_data`. And `user_data` has to be finalised _at the moment the instance is created_ — it's the very script that boots the machine.

Which is a problem, because Vultr assigns an instance its IP address _when it creates the instance_. You can't know the IP before the instance exists, and you can't create the instance without `user_data` that already contains the IP.

A reserved IP breaks the loop. It's a separate Vultr resource with its own lifecycle:

```hcl
resource "vultr_reserved_ip" "main" {
  region  = data.vultr_region.melbourne.id
  ip_type = "v4"
  label   = "instance-starter-ip"
}
```

Terraform creates the reserved IP first, then attaches it to the instance via `reserved_ip_id`. Because the reserved IP exists as its own resource, its address is a known value _before_ the instance is built, so the template can reference it directly:

```hcl
django_allowed_hosts = "${vultr_reserved_ip.main.subnet},${var.domain},localhost,127.0.0.1"
```

There's a second payoff. The reserved IP outlives the instance. I can `terraform destroy` the server and `apply` a fresh one, and it comes back on the same address — which means the DNS record pointing at it never needs touching, and the SSL step in the next section can rely on the domain already resolving.

---

## Hands-Off SSL

The last thing `cloud-init` does is obtain a Let's Encrypt certificate:

```yaml
- apt-get install -y certbot python3-certbot-nginx
- certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${certbot_email} --redirect
```

`--non-interactive` is the operative flag — Certbot normally asks questions, and there's no one at a terminal to answer them during provisioning. `--agree-tos` and `-m` supply the answers up front; `--redirect` tells Certbot to add the HTTP-to-HTTPS redirect.

`--nginx` lets Certbot edit the Nginx config itself, and that imposes one requirement on the config file. Certbot finds the right server block by matching `server_name`, so the config has to name the real domain — not Nginx's catch-all `_`:

```nginx
server {
    server_name instance-starter.leighwest.dev;
    # ...no listen directive here
}
```

There's also deliberately no `listen` directive in that file. Certbot owns it — it adds the `listen 443 ssl` block, wires in the certificate paths, and creates the port 80 block that does the redirect. Defining `listen 80` yourself just gets in its way.

This step only works because the domain already resolves to the server — Certbot's HTTP-01 challenge needs to reach the box on port 80. That's the value of the reserved IP: the DNS A record was set once, points at an address that never changes, and is correct on every rebuild.

---

## What's Still Manual

The post would be dishonest if it claimed the apply is _completely_ hands-off. Three things still need a human:

**The self-hosted CI/CD runner.** Deploys run through a self-hosted GitHub Actions runner on the server, and installing it isn't in `cloud-init` yet. That runner is interesting enough (outbound-only, no SSH secrets in GitHub) to deserve its own post, so I've left it out of this one.

**GHCR authentication.** The server pulls its Docker image from the GitHub Container Registry, which needs a `docker login` with a personal access token. That's a manual step after each fresh provision.

**The reserved IP on destroy.** Vultr's API errors when detaching a reserved IP from an instance that's already gone, so `terraform destroy` needs a small manual nudge — delete the reserved IP in the dashboard and `terraform state rm` it before re-applying.

None of these stops the core promise: from one command, the server goes from nothing to a running, HTTPS-secured app. The remaining edges are on the list.
