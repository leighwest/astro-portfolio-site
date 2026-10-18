---
title: Issue Tracker
publishDate: 2026-10-18 00:00:00
img: /assets/issue-tracker.webp
img_alt: Dark-themed Beacon incident tracker dashboard showing counters for 4 open, 0 acknowledged and 1 resolved incident, above a list of five demo incidents, each with a severity, assignee and ID, and an Acknowledge button on the open ones
description: >-
  An event-driven issue tracker built as a working demonstration of Kafka, schema-governed events, JWT authentication and testing depth - with a live demo you can use without signing up for anything.
tags:
  - Kafka
  - Spring Boot
  - Java
  - React
  - Avro
links:
  - label: Live site
    url: https://issue-tracker.leighwest.dev
  - label: Live API
    url: https://issue-tracker-api.leighwest.dev
  - label: Frontend repo
    url: https://gitlab.com/leighwest-dev/homelab/issue-tracker-web
  - label: API repo
    url: https://gitlab.com/leighwest-dev/homelab/issue-tracker-api
---

## What it is

An issue tracker for a fictional support desk - tickets move through three states, and every transition is published as an event. It is running right now, and you can use it without creating an account or handing over an email address.

The domain is deliberately unambitious. Three states, `OPEN` <span class="arrow">→</span> `ACKNOWLEDGED` <span class="arrow">→</span> `RESOLVED`, one legal path through them, no workflow builder and no custom fields. That's the point: the interesting problems in this project are messaging, schema governance, authentication and testing, and a complicated domain would only get in the way.

## How it works

Type a name on the landing page and press the button. There's no password, no email verification and no signup form - the backend finds or creates a user and issues a JWT, and you're straight into the board.

The authentication underneath is real - RS256 access tokens with a five-minute expiry, single-use refresh tokens hashed at rest and delivered in an httpOnly cookie, silent refresh from the frontend when a call comes back 401, and role-based authorisation enforced with `@PreAuthorize` on every endpoint. Demo users are issued the AGENT role, which can create and transition tickets. CUSTOMER and ADMIN are real, enforced roles reachable through seeded accounts rather than the demo flow, on the principle that no real system hands out admin through public signup.

Move a ticket from `OPEN` to `ACKNOWLEDGED` and the board updates immediately. Behind that, the API validates the transition against a state machine, saves the ticket, and publishes a `TicketStatusChanged` event to Kafka. A separate audit consumer reads that event and writes the audit trail. The API doesn't write the audit row itself.

## The engineering story

**The audit trail is event-driven, not synchronous.** The transition endpoint updates the ticket and publishes an event, and the audit consumer is the sole writer to the audit table. That’s a deliberate eventual-consistency trade. The audit row appears shortly after the transition rather than atomically with it, and in exchange the audit trail can be rebuilt from the event log and new consumers can be added without touching the producer. The events are Avro, serialised against a Confluent Schema Registry, on a three-broker KRaft cluster with replication factor three and `min.insync.replicas=2`. Poison messages retry three times and then route to a dead letter topic that the application deliberately doesn’t consume, because triage is an operational concern rather than a business one.

**The producer fails loudly.** A database write and a Kafka publish can't be made atomic, and pretending otherwise is how systems quietly diverge. The publisher is wrapped in Resilience4j retry and a circuit breaker, and when it exhausts both it throws - which rolls the surrounding transaction back and returns a 503. The ticket doesn't move unless the event goes out. A transactional outbox would eliminate the remaining window entirely. It’s worth it where a lost event costs money or compliance; here, the worst case is a missing audit row, which doesn’t justify another table and a relay process.

**Schema governance from the start.** Using Avro over a registry rather than JSON isn't about the wire format. It means the event contract is a versioned, registered artifact with an enforced compatibility rule, so a field rename that would silently break every consumer is rejected at publish time rather than found in production. The same instinct applies to the database - Flyway owns the schema from the first commit, with Hibernate in `validate` mode, in every environment except unit tests.

**Structured logging and metrics, not retrofitted.** Every log line is JSON with a correlation ID generated per request, or propagated from an incoming `X-Correlation-ID` header for cross-service tracing, along with the ticket ID and username where relevant. Micrometer counters track ticket creation and transitions, tagged by from-state and to-state, and Prometheus scrapes them alongside Kafka consumer lag.

**Testing across three layers.** Unit tests with mocked collaborators for the state machine and service logic, integration tests against a real Postgres in a throwaway container for the controllers and auth flow, and an embedded broker for the dead letter path so the poison-message contract is actually asserted rather than assumed.

## Deployment

The API and frontend run on a single-node K3s cluster on a mini PC on my desk. They’re packaged as Helm charts and deployed through Flux, so the cluster’s state comes from Git rather than from a pipeline pushing to it. Postgres, the three Kafka brokers, Schema Registry, Prometheus and Grafana still run under Docker Compose on the same host, and moving them into the cluster is the next stage. GitLab CI builds, tests and publishes each image, and public traffic comes in through a Cloudflare Tunnel, so no inbound ports are open. 

## Where this is going

The next piece is a Go service that owns the dead letter topic - structured logging of failed records, a metric for alerting on DLT depth, and a replay endpoint to requeue records once the underlying cause is fixed. Replay is a privileged machine-to-machine operation with no user in the loop, which makes it the one genuine place for mutual TLS in an otherwise asynchronous architecture. The cluster already runs a private CA through cert-manager, so replay is where it starts issuing client certificates and those certificates become the authorisation boundary.

## Tech stack

Java 21 and Spring Boot 3.5, Spring Security as an OAuth2 resource server with RS256 JWTs, Spring Data JPA, Postgres and Flyway. Spring Kafka against a three-broker KRaft cluster with Confluent Schema Registry and Avro, Resilience4j for retry and circuit breaking, Micrometer and Prometheus for metrics, Logback with structured JSON output. React, TypeScript and Vite on the frontend, with the access token held in memory and the refresh token in an httpOnly cookie. Springdoc OpenAPI, JUnit 5, Testcontainers and embedded Kafka for tests. K3s, Helm and Flux for the apps, Docker Compose for the stateful services, self-hosted GitLab CI, Cloudflare Tunnel, and Terraform for DNS and ingress.

## Links

- **Live site:** [issue-tracker.leighwest.dev](https://issue-tracker.leighwest.dev)
- **Live API:** [issue-tracker-api.leighwest.dev](https://issue-tracker-api.leighwest.dev)
- **Frontend repository:** [gitlab.com/leighwest-dev/homelab/issue-tracker-web](https://gitlab.com/leighwest-dev/homelab/issue-tracker-web)
- **API repository:** [gitlab.com/leighwest-dev/homelab/issue-tracker-api](https://gitlab.com/leighwest-dev/homelab/issue-tracker-api)
