---
title: Why I Replaced Kafka with SQS for my Spring Boot App
publishDate: 2026-04-24 00:00:00
img: /assets/blog/kafka-to-sqs.webp
img_alt: A Kafka logo and an AWS SQS logo side by side with an arrow between them, showing the migration from Kafka to SQS
description: |
  Kafka is a great technology. It's also complete overkill for a single EC2 instance with one producer and one consumer. Here's why I swapped it out for SQS, and what that actually looked like in Spring Boot.
tags:
  - AWS
  - SQS
  - Kafka
  - Spring Boot
  - Architecture
---

## TL;DR

Kafka was consuming around 512 MB on a t3.small that also needed to run a Spring Boot app and MySQL. I replaced it with SQS. One less thing to manage, and I didn't lose anything I was actually using.

---

## The Problem

When I first built my [cupcake orders service](https://github.com/leighwest/orders), I used Kafka for the messaging layer between the app and a small Spring Boot microservice that simulated order dispatch. An order came in, got published to a Kafka topic, the dispatch service picked it up, processed it, published a response back, and the app sent a confirmation email. Conceptually clean.

The problem was operational. Running Kafka locally meant an extra container, a custom Dockerfile, and a named volume just to move a message from one place to another. On a t3.small (2 GB RAM) shared with Spring Boot and MySQL, Kafka was sitting at around 512 MB at idle. That's a quarter of my total memory budget gone before the app had done anything useful.

In production on EC2, the story was the same. I wasn't using any of the features that justify Kafka's complexity — no consumer groups, no replay, no log compaction, no high-throughput fan-out. I had one producer and one consumer, and Kafka was doing the job of a simple queue.

## The Decision

SQS is a managed queue; no broker to run, no Zookeeper, no retention log to manage. AWS handles availability, scaling, and delivery — I just publish and consume.

For this use case the trade-offs are straightforward:

**What I gave up:**

- Message replay (SQS deletes messages after successful consumption)
- Strict ordering guarantees (SQS standard queues are best-effort ordered)
- High-throughput fan-out to multiple consumer groups

**What I gained:**

- ~512 MB back on the instance
- No Kafka or Zookeeper containers in Docker Compose
- AWS handles SQS polling via Lambda — no consumer configuration to manage
- One less thing to operate

None of what I gave up was relevant to this use case.

The other factor was Spring Cloud AWS. Version 3.x has a solid SQS integration that handles the listener lifecycle, deserialisation, and acknowledgement. The implementation effort was low.

---

## The Implementation

### Dependencies

Out with Kafka, in with Spring Cloud AWS SQS:

```xml
<!-- removed -->
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>

<!-- added -->
<dependency>
    <groupId>io.awspring.cloud</groupId>
    <artifactId>spring-cloud-aws-starter-sqs</artifactId>
    <version>3.1.1</version>
</dependency>
```

### The Publisher

Publishing to SQS is about as simple as it gets. Spring Cloud AWS gives you a `SqsTemplate` that handles serialisation:

```java
@Service
public class OrderRequestSqsPublisher {

    private final String orderCreatedQueue;
    private final SqsTemplate sqsTemplate;

    public OrderRequestSqsPublisher(
            @Value("${sqs.order-created-queue}") String orderCreatedQueue,
            SqsTemplate sqsTemplate) {
        this.orderCreatedQueue = orderCreatedQueue;
        this.sqsTemplate = sqsTemplate;
    }

    public void process(DispatchOrder dispatchOrder) {
        sqsTemplate.send(orderCreatedQueue, dispatchOrder);
    }
}
```

### The Listener

The `@SqsListener` annotation handles polling, deserialisation, and deletion on successful processing:

```java
@SqsListener("${sqs.order-dispatched-queue}")
public void receive(DispatchOrder payload) {
    if (payload.getDispatchStatus() == DispatchStatus.COMPLETED) {
        orderRepository.findById(payload.getOrderId())
            .ifPresent(orderDispatchedEmailSender::send);
    }
}
```

### Config

```properties
spring.cloud.aws.region.static=ap-southeast-4
sqs.order-created-queue=order-created
sqs.order-dispatched-queue=order-dispatched
```

In production the app runs on an EC2 instance with an IAM instance role — no credentials in config. Locally I use the AWS CLI credentials file.

### Removing Kafka from Docker Compose

Before — an extra service and a named volume just to move messages between two services:

```yaml
kafka:
  container_name: kafka
  build:
    context: ./docker
    dockerfile: Dockerfile.kafka
  ports:
    - 9092:9092
  ...
volumes:
  data:
  kafka:
```

After — gone. The named kafka volume goes with it.

---

## What Went Wrong

The end-to-end flow worked first time, which was suspicious. Turns out it was working in the sense that messages were being published and consumed — but the dispatch Lambda was setting a field called `status` on the message, and my `DispatchOrder` model expected `dispatchStatus`.

The Lambda wasn't failing. The app wasn't failing. The field was just silently null on the consumer side. I only caught it because I was logging the consumed event and noticed the status field wasn't being populated.

Lesson: when a message-passing integration "works" immediately, check that the payload contract is actually being honoured end to end — not just that messages are flowing.

---

SQS isn't the right tool for every job, but it was the right tool for this one. If you're running Kafka on a single instance with one producer and one consumer, it's worth asking whether you actually need it.

> _The code referenced in this post is tagged [v1.0.0](https://github.com/leighwest/orders/tree/v1.0.0)._
