---
title: GitOps in Practice — What Flux Actually Teaches You
publishDate: 2024-11-01 00:00:00
img: /assets/blog/flux-horizontal-color.png
img_alt: A terminal window showing a successful Flux reconciliation
description: |
  GitOps sounds simple until you're debugging a Kustomize patch at midnight. Here's what a year of running Flux in production actually looks like.
tags:
  - Kubernetes
  - GitOps
  - DevOps
---

The pitch for GitOps is clean: your Git repository is the source of truth, and your cluster converges toward whatever's declared there. Flux watches the repo, detects drift, and reconciles. Simple.

Then you do it for real and discover that "simple" was doing a lot of heavy lifting in that sentence.

## What actually happens on day one

You install Flux, point it at a repo, and it works. You feel good. Then you try to manage multiple environments — dev, staging, prod — and suddenly you're deep in Kustomize overlays, wondering why a patch that works locally isn't applying in the cluster.

The thing Flux teaches you, faster than any tutorial, is that your configuration is only as clean as your Git history. If your overlays are tangled, your cluster will be tangled. There's no runtime magic to hide it.

## Kustomize is a feature, not a workaround

A lot of teams reach for Helm first because it's familiar. Helm is fine. But Kustomize with Flux has a composability that pays off once you have more than two environments. The `bases` + `patches` model forces you to be explicit about what varies per environment — which turns out to be exactly the right question to ask.

The friction is upfront. The clarity is ongoing.

## What I'd tell someone starting out

Keep your Flux configuration in a dedicated repo, separate from application code. It sounds like extra overhead but it means your platform team (or future you) can reason about cluster state without wading through application history.

Start with one environment fully working before adding a second. The temptation to parallelise is real. Resist it.

And read the Flux event logs. `kubectl get events -n flux-system` will tell you almost everything you need to know about why a reconciliation failed. It's underused.