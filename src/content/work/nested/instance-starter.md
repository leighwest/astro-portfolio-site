---
title: Instance Starter
publishDate: 2026-05-28 00:00:00
img: /assets/instance-starter.webp
img_alt: Illustrated control panel with a large green start button, a status light, and a stylised AWS EC2 instance icon on the screen above it
description: |
  A web application for starting and stopping AWS EC2 instances on demand,
  built as a working demonstration of zero-touch provisioning, CI/CD, and
  real-time status with WebSockets.
tags:
  - Terraform
  - cloud-init
  - IaC
  - GitHub Actions
  - Nginx
links:
  - label: Live site
    url: https://instance-starter.leighwest.dev
  - label: Application repo
    url: https://github.com/leighwest/instance-starter
  - label: Infrastructure repo
    url: https://github.com/leighwest/instance-starter-infra
---

## What it is

Instance Starter is a small Django application that starts and stops AWS EC2 instances from a web UI, with live status updates and an automatic shutdown timer. It is not a tutorial project sitting in a repo — it runs on a Vultr VPS, it controls real EC2 instances in `ap-southeast-4` (Melbourne), and you can use it right now.

The application itself is intentionally small. The interesting part is everything around it: a fully reproducible server from a single `terraform apply`, a two-job CI/CD pipeline that pushes images to a registry and pulls them on a self-hosted runner, and a real-time UI driven by WebSockets and Celery. I built it as a vehicle for working through infrastructure-as-code, CI/CD, and operational patterns properly, with every decision documented as I went.

## How it works

The user opens the site, sees two EC2 instances listed with their current state, and clicks "Start" on one of them. Django calls `start_instances` via boto3, and a Celery task begins polling AWS every second to track the transition. Each poll pushes a WebSocket message back to the browser, so the UI updates in near-real-time — pulsing amber while the instance is starting, green once it is running, with the public IP appearing as soon as AWS assigns one.

At the same time, a second Celery task is scheduled to fire 250 seconds later and stop the instance automatically. The expiration time is stored as an EC2 tag, the task ID is stored in Redis, and the UI shows a per-second countdown. If any user clicks Extend on an already-running instance, the existing scheduled stop is revoked and a fresh 250-second timer takes its place — extending the window for everyone currently on the page. No stale shutdowns.

Each EC2 instance serves a styled landing page from Nginx, with its own instance ID baked in at first boot via the IMDSv2 metadata service. A "View Site" button appears in the UI once the application is confirmed healthy, with the health check proxied through Django server-side to avoid the browser's mixed-content restriction on HTTPS pages calling HTTP endpoints.

## The engineering story

The application code is the smallest part of the project. The parts I am most pleased with are operational.

**Zero-touch provisioning.** A single `terraform apply` takes the project from nothing to a fully working, HTTPS-enabled server. Terraform provisions the Vultr instance with a reserved IP, attaches a firewall group, and hands cloud-init a fully templated bootstrap script that installs Docker, creates a deploy user with SSH key auth, writes the Nginx config and `.env` file, clones the app repo, runs migrations, creates the Django superuser, syncs the EC2 instances into the database, and obtains a Let's Encrypt certificate non-interactively. The Nginx config is read from a separate file by Terraform and injected into cloud-init via `file()` + `indent()` — keeping the YAML valid while keeping the Nginx config out of the Terraform itself. I wrote this up as [zero-touch server provisioning with Terraform and cloud-init](/blog/zero-touch-provisioning).

**CI/CD without exposed credentials.** Every push to main triggers a two-job GitHub Actions workflow. The first job runs on a GitHub-hosted runner, builds the Docker image, and pushes it to GHCR. The second job runs on a self-hosted runner living on the Vultr server itself, pulls the new image, and redeploys. The self-hosted runner connects outbound to GitHub via a systemd-managed agent — there is no inbound SSH port for GitHub Actions to use, no SSH private key sitting in GitHub Secrets, and no whitelist of GitHub Actions IP ranges to maintain.

**Moving builds off the server.** The Vultr instance has 1 GB of RAM. Earlier in the project, the self-hosted runner did everything — including the Docker build — and routinely ran out of memory during the build step. Splitting the workflow so that the build runs on a 16 GB GitHub-hosted runner and the deploy step only pulls a finished image solved this cleanly. Authentication is split too: a short-lived `GITHUB_TOKEN` pushes from the GitHub-hosted runner, and a classic personal access token stored on the server handles the pull. Fine-grained tokens were the obvious first choice; they turned out not to support `read:packages` for GHCR, which was a surprise worth noting.

**Real-time status.** The Celery polling pattern — `bind=True` and `self.retry(countdown=1)` — re-queues the task every second rather than blocking a worker thread on a `sleep` loop. Redis acts as both the Celery broker and a lightweight key-value store for the task IDs that need to be revoked when an instance is restarted before its scheduled stop fires. The auto-shutdown timer is itself a Celery `apply_async(eta=...)` call rather than a separate scheduled Lambda, which keeps everything inside a single execution model and avoids a second piece of infrastructure for a single behaviour.

## A note on the EC2 instances

The two EC2 instances controlled by the app are provisioned by Terraform in a stopped state and tagged with `Role=instance-starter-toy`. Django discovers them by tag via a `sync_instances` management command rather than holding any instance IDs in code, so a Terraform `taint` and re-apply produces new IDs without breaking anything. Starting an instance from stopped takes around 20 seconds; provisioning from scratch would take three to five minutes, which is too long for a demo. The 250-second auto-shutdown keeps the running cost negligible — instances are stopped almost all of the time.

## Where this is going

The next project in the pipeline is a meaningful step up in complexity: a mini PC running k3s locally, with Grafana, Loki, and Prometheus, hosting a small issue tracker as the application under observation. Instance Starter has been about provisioning, deployment, and operating a single-server application well; the next one is about Kubernetes, observability, and the platform engineering side of the same problem.

A couple of smaller items remain on the Instance Starter backlog itself: automating the self-hosted runner installation in cloud-init (currently a manual step after each `terraform apply`), and working around a Vultr reserved-IP detach issue during `terraform destroy`.

## Tech stack

Django 5 and Python 3.11, Daphne for ASGI, Channels for WebSockets, Celery worker and beat for background tasks and scheduled broadcasts. PostgreSQL and Redis. Docker Compose for local development and production. Nginx for HTTP termination, HTTPS, and reverse proxying to Django. Terraform for all infrastructure across Vultr and AWS. GitHub Actions for CI/CD, with a self-hosted runner on the Vultr server and image hosting on GHCR. Let's Encrypt via Certbot for certificates.

## Links

- **Live site:** [instance-starter.leighwest.dev](https://instance-starter.leighwest.dev)
- **Application repository:** [github.com/leighwest/instance-starter](https://github.com/leighwest/instance-starter)
- **Infrastructure repository:** [github.com/leighwest/instance-starter-infra](https://github.com/leighwest/instance-starter-infra)