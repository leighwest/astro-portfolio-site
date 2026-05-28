---
title: Cupcakes API
publishDate: 2026-05-27 00:00:00
img: /assets/cupcake-store.webp
img_alt: llustrated pink-and-cream cupcake shopfront with a striped awning, a window display of frosted cupcakes, and an "Open" sign on the door
description: |
  An event-driven cupcake ordering service on AWS, built as a working
  demonstration of cloud architecture, CI/CD, and deliberate cost engineering.
tags:
  - AWS
  - Spring Boot
  - Java
  - DevOps
links:
  - label: Live API
    url: https://cupcakes-api.leighwest.dev
  - label: Application repo
    url: https://github.com/leighwest/orders
  - label: Infrastructure repo
    url: https://github.com/leighwest/orders-infra
---

## What it is

The Cupcakes API is a real, deployed ordering service for a fictional cupcake shop. It is not a tutorial project sitting in a repo — it runs on AWS, it processes orders end to end, and it sends real email. I built it as a vehicle for working through cloud architecture, infrastructure-as-code, and CI/CD properly, with every decision documented as I went.

The interesting part is not the cupcakes. It is everything around them: an event-driven backend, fully automated deployment, and an infrastructure setup that has been steadily engineered down from roughly $40 AUD a month to under $20.

## How it works

When a customer places an order, the service saves it, sends an "order received" email, and publishes a message to an SQS queue. A Lambda function picks that message up, processes the order, and publishes its own message to a second queue. The service consumes that and sends an "order dispatched" email to the customer.

That indirection is the point. Rather than one service doing everything in a single blocking call, the work is broken into stages that communicate through a message bus. Each stage can fail, retry, and scale independently. It is a small system, but it is built the way a larger event-driven system is built — which was the goal. The move to SQS was itself a deliberate change: the service originally ran on Kafka, and I wrote up [why I replaced it with SQS](/blog/kafka-to-sqs) for a single-instance deployment.

## The engineering story

The architecture is event-driven, but the part I am most pleased with is the operational side.

**Cost engineering.** The service does not need to be available overnight, so it isn't. An EventBridge schedule starts the EC2 instance at 7am and stops it at 8pm, Melbourne time, with daylight saving handled automatically. Because the instance only runs for thirteen hours a day, compute cost roughly halves. I also dropped the Elastic IP — a flat monthly charge — and instead update the DNS record with the instance's new public IP each morning when it boots. Together these two changes have taken the all-in running cost from around $40 AUD a month to around $19, with a planned move to ARM-based Graviton instances expected to bring it under $10.

**Deployment.** Every push to the main branch builds, tests, and packages the application, pushes a Docker image to ECR, and deploys it to EC2 — no manual steps. A second repository manages all the AWS infrastructure as Terraform, with its own pipeline. Application secrets live in AWS Systems Manager Parameter Store as a single source of truth, rather than being scattered across config files. I wrote up [deploying to EC2 with GitHub Actions and ECR](/blog/spring-boot-ec2-github-actions) separately.

**Access without open ports.** There is no SSH port open on the instance. Administrative access goes through AWS Systems Manager Session Manager, which is IAM-controlled and fully audited. This is the pattern used in enterprise environments to avoid bastion hosts and exposed SSH, and moving to it was a worthwhile exercise in itself.

**Testing.** The service is covered by unit and integration tests, the latter running against a real database in a throwaway container so that database-specific behaviour is actually exercised. Getting a message-driven application under test without depending on live AWS infrastructure took some care — I wrote about [testing a Spring Boot SQS app without hitting AWS](/blog/testing-spring-boot-sqs).

## A note on availability

The live API is online between roughly 7am and 8pm Melbourne time. Keeping a hobby-scale service running around the clock costs money for no real benefit, so the infrastructure is built around a scheduled uptime window — the trade-off being explicit and managed rather than hidden. If you visit outside those hours, the site will be unreachable; that is the system working as designed, not a fault.

## Where this is going

The project is built in deliberate, documented stages, and the next few are about modernising the application itself: migrating the database from MySQL to Postgres for a lighter footprint and a cleaner cloud-native story, upgrading to Java 21 with virtual threads and a tuned JVM, and finally compiling the service to a GraalVM native image. The native image is the headline goal — it cuts resident memory from roughly 300 MB to 150 MB and startup from around 30 seconds to 5, which is what allows the whole stack to run comfortably on the smallest viable instance. Each of these stages is being written up as I complete it.

## Tech stack

Java 17 and Spring Boot, Spring Cloud AWS for SQS and S3, AWS SDK v2. MySQL in production with H2 and Testcontainers for tests. Docker Compose for local development and production, Nginx for HTTP termination and HTTPS. AWS — EC2, Lambda, SQS, SES, EventBridge, ECR, Route 53, Systems Manager. Terraform for all infrastructure, GitHub Actions for CI/CD.

## Links

- **Live API:** [cupcakes-api.leighwest.dev](https://cupcakes-api.leighwest.dev) _(online ~7am–8pm AEST)_
- **Application repository:** [github.com/leighwest/orders](https://github.com/leighwest/orders)
- **Infrastructure repository:** [github.com/leighwest/orders-infra](https://github.com/leighwest/orders-infra)
