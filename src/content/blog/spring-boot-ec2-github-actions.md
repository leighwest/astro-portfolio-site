---
title: Deploying a Spring Boot App to EC2 with GitHub Actions and ECR
publishDate: 2026-05-09 00:00:00
img: /assets/blog/spring-boot-ec2-github-actions.webp
img_alt: A code editor with the GitHub logo, connected by arrows through a GitHub Actions workflow diagram to an AWS EC2 instance with a Spring Boot logo
description: >-
  A three-job GitHub Actions pipeline that builds and tests a Spring Boot app, pushes a Docker image to ECR, and deploys it to EC2 — with secrets fetched from SSM Parameter Store at deploy time, not stored in GitHub.
tags:
  - GitHub Actions
  - AWS
  - EC2
  - ECR
  - Spring Boot
  - CI/CD
---

## TL;DR

Three sequential jobs: build and test, push to ECR, deploy to EC2. Secrets live in AWS SSM Parameter Store and are fetched at deploy time — not duplicated into GitHub secrets. SSH is open to `0.0.0.0/0`; the private key is the security boundary.

---

## The Setup

My [cupcake orders service](https://github.com/leighwest/orders) is a Spring Boot app running on a single EC2 instance, with infrastructure managed via Terraform in a [companion repo](https://github.com/leighwest/orders-infra). The app runs as a Docker container behind Nginx, orchestrated by Docker Compose.

The pipeline needed to do three things on every push to main:

1. Build the app and run the tests
2. Package it as a Docker image and push to ECR
3. Pull the new image on EC2 and restart the containers

---

## The Pipeline

### Job 1: Build and test

```yaml
build-and-test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v5

    - name: Set up JDK 17
      uses: actions/setup-java@v5
      with:
        java-version: '17'
        distribution: 'temurin'
        cache: maven

    - name: Build and test
      run: ./mvnw verify
```

Nothing exotic here. `./mvnw verify` runs compile, test, and package. The integration tests use Testcontainers, so Docker needs to be available on the runner — it is on `ubuntu-latest` by default.

Maven dependencies are cached between runs using the `cache: maven` option on the Java setup step, which cuts a meaningful chunk off the build time.

### Job 2: Push to ECR

```yaml
push-to-ecr:
  runs-on: ubuntu-latest
  needs: build-and-test
  outputs:
    registry: ${{ steps.login-ecr.outputs.registry }}

  steps:
    - uses: actions/checkout@v5

    - name: Set up JDK 17
      uses: actions/setup-java@v5
      with:
        java-version: '17'
        distribution: 'temurin'
        cache: maven

    - name: Package jar
      run: ./mvnw package -DskipTests

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v6.1.0
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ap-southeast-4

    - name: Log in to Amazon ECR
      id: login-ecr
      uses: aws-actions/amazon-ecr-login@v2.1.4

    - name: Build and push image to ECR
      env:
        REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        IMAGE_TAG: ${{ github.sha }}
      run: |
        docker build \
          -f docker/Dockerfile.orders.prod \
          -t $REGISTRY/orders:$IMAGE_TAG \
          -t $REGISTRY/orders:latest \
          .
        docker push $REGISTRY/orders:$IMAGE_TAG
        docker push $REGISTRY/orders:latest
```

The jar is repackaged here without tests (`-DskipTests`) — the tests already ran and passed in Job 1. The image is tagged twice: once with the commit SHA for traceability, and once as `latest` so the EC2 deploy step can always pull a known tag without needing to pass the SHA across jobs.

### Job 3: Deploy to EC2

This is the most involved job. It starts the instance if it isn't already running, copies the Compose file and Nginx config over via SCP, then SSHs in to pull the new image and restart the containers.

```yaml
deploy-to-ec2:
  runs-on: ubuntu-latest
  needs: push-to-ecr

  steps:
    - name: Checkout
      uses: actions/checkout@v5

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v6.1.0
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ap-southeast-4

    - name: Start EC2 instance
      run: |
        STATE=$(aws ec2 describe-instances \
          --instance-ids ${{ secrets.INSTANCE_ID }} \
          --query "Reservations[0].Instances[0].State.Name" \
          --output text)
        if [ "$STATE" != "running" ]; then
          aws ec2 start-instances --instance-ids ${{ secrets.INSTANCE_ID }}
          aws ec2 wait instance-running --instance-ids ${{ secrets.INSTANCE_ID }}
          sleep 30
        fi

    - name: Copy files to EC2
      uses: appleboy/scp-action@v0.1.7
      with:
        host: ${{ secrets.EC2_HOST }}
        username: ec2-user
        key: ${{ secrets.EC2_SSH_KEY }}
        use_insecure_cipher: true
        source: 'docker-compose.prod.yaml,docker/,nginx/'
        target: '/home/ec2-user/'
        overwrite: true

    - name: Deploy via SSH
      uses: appleboy/ssh-action@v1
      with:
        host: ${{ secrets.EC2_HOST }}
        username: ec2-user
        key: ${{ secrets.EC2_SSH_KEY }}
        script: |
          aws ecr get-login-password --region ap-southeast-4 \
            | docker login --username AWS --password-stdin \
              $(aws sts get-caller-identity --query Account --output text).dkr.ecr.ap-southeast-4.amazonaws.com

          REGISTRY=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.ap-southeast-4.amazonaws.com

          export MYSQL_ROOT_PASSWORD=$(aws ssm get-parameter \
            --name orders_mysql_password --with-decryption \
            --query Parameter.Value --output text --region ap-southeast-4)
          export MAIL_USERNAME=$(aws ssm get-parameter \
            --name orders_ses_smtp_username --with-decryption \
            --query Parameter.Value --output text --region ap-southeast-4)
          export MAIL_PASSWORD=$(aws ssm get-parameter \
            --name orders_ses_smtp_password --with-decryption \
            --query Parameter.Value --output text --region ap-southeast-4)
          export ORDERS_IMAGE=$REGISTRY/orders:latest

          echo "MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD" > /home/ec2-user/.env
          echo "MAIL_USERNAME=$MAIL_USERNAME" >> /home/ec2-user/.env
          echo "MAIL_PASSWORD=$MAIL_PASSWORD" >> /home/ec2-user/.env
          echo "ORDERS_IMAGE=$ORDERS_IMAGE" >> /home/ec2-user/.env

          docker-compose -f docker-compose.prod.yaml pull
          docker-compose -f docker-compose.prod.yaml up -d
          docker image prune -f
```

A few things worth calling out in the deploy script.

**The instance state check.** `start-instances` throws an error if the instance is already running — which happens when a fresh Terraform apply has just created it. The state check prevents that.

**ECR login on the instance.** The EC2 instance has an IAM instance role with ECR pull permissions. The `docker login` command uses `aws ecr get-login-password` to exchange that role for a temporary Docker registry token — no credentials stored anywhere.

**Fetching secrets from SSM.** More on this below.

**`docker image prune -f`** cleans up old image layers after the pull. On a small instance, image accumulation adds up quickly.

---

## Why Secrets Live in SSM, Not GitHub

The naive approach is to put `MYSQL_ROOT_PASSWORD`, `MAIL_USERNAME`, and `MAIL_PASSWORD` directly into GitHub Actions secrets, then inject them as environment variables in the workflow. It works, but it creates two sources of truth — one in GitHub, and one wherever else you manage your infrastructure config. If you rotate a credential, you have to remember to update it in both places.

SSM Parameter Store is already where AWS infrastructure config lives. Fetching secrets from there at deploy time means there's one place to update a credential and it takes effect on the next deploy automatically. GitHub only needs to know enough to authenticate with AWS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) — it doesn't hold any application secrets.

The secrets are fetched with `--with-decryption`, which means they're stored as `SecureString` parameters encrypted at rest with KMS.

**Worth noting:** the secrets are written to a `.env` file on the instance using `echo`. Shell string interpolation means special characters in secret values can cause problems — a `#` in a password, for example, will be treated as the start of a comment and silently truncate the value. The workaround is to use alphanumeric-only secret values. This is a known rough edge to be cleaned up in a later phase when the `.env` file approach is replaced entirely.

---

## The SSH Question

Port 22 in the security group is open to `0.0.0.0/0`. For a production system, that's not acceptable. For a hobby project with a single developer, the private key is the real security boundary. If the key is not compromised, the open port is not a meaningful risk.

The reason it's open to all IPs rather than whitelisted to GitHub Actions is that GitHub's IP range for Actions runners is large and changes frequently. Maintaining a whitelist would be more work than it's worth.

It's on the list to fix — SSM Session Manager is next, which removes the SSH surface entirely.

---

## The Terraform Pipeline

The [orders-infra repo](https://github.com/leighwest/orders-infra) has its own pipeline that runs on every push to main: terraform init → fmt check → validate → plan → apply. State is stored in S3. It auto-applies on merge — there's no one else committing to this repo, so a manual approval gate on the plan would just be unnecessary friction.

---

## What I'd Do Differently

**Drop the `.env` file.** Writing secrets to disk with `echo` is the source of the special-character problem mentioned above. The cleaner approach is to `export` the variables directly into the shell environment. Docker Compose picks up exported environment variables automatically, so no file needed, and no escaping issues.

**Look up `INSTANCE_ID` and `EC2_HOST` dynamically.** Both are stored as GitHub secrets, which means they need manual updates whenever the instance is recreated — after a Terraform `taint`, an AMI swap, or any other reason the instance ID changes. A better approach is to look them up by tag in the workflow itself: `aws ec2 describe-instances --filters "Name=tag:Name,Values=orders-server"` gives you the instance ID and public IP without any hardcoding. One less thing to remember to update.

**Add `--region` to SSM calls from the start.** The SSH session that runs the deploy script doesn't inherit your AWS CLI region configuration. Every `aws ssm get-parameter` call needs an explicit `--region` flag or it fails silently against the wrong region. This one took longer to diagnose than it should have because the error message wasn't immediately obvious about the cause.

**`overwrite: true` on SCP from day one.** The SCP step copies `nginx/nginx.conf` to the EC2. On the first failed deploy attempt, the action created `nginx/nginx.conf` as a directory instead of a file. Every subsequent deploy then failed with `Cannot open: File exists`. The fix was to SSH in and manually delete it, then add `overwrite: true` to the SCP step. Starting with `overwrite: true` avoids the whole situation.

---

## GitHub Actions Secrets

For reference, the secrets the pipeline needs:

| Secret                  | What it is                                                      |
| ----------------------- | --------------------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | IAM user with ECR push, EC2 start, SSM read permissions         |
| `AWS_SECRET_ACCESS_KEY` | As above                                                        |
| `EC2_HOST`              | Public IP or DNS of the EC2 instance                            |
| `EC2_SSH_KEY`           | Private SSH key (the instance has the corresponding public key) |
| `INSTANCE_ID`           | EC2 instance ID — used for the start and state-check steps      |

`EC2_HOST` and `INSTANCE_ID` need to be updated if the instance is ever recreated (after a Terraform `taint`, an AMI swap, etc.).

---

The pipeline isn't complicated, but getting the details right — the state check before starting the instance, the ECR login flow, the SSM fetch approach, the `overwrite: true` on SCP — took a few iterations. Hopefully this saves you some of that.

> _This post reflects the pipeline as it stood at [v1.0.0](https://github.com/leighwest/orders/tree/v1.0.0). The SSH and SCP steps were later replaced with SSM Session Manager in [v1.1.0](https://github.com/leighwest/orders/tree/v1.1.0)._
