---
title: "When Your Database Uses More Memory Than Your App: MySQL to Postgres"
publishDate: 2026-06-13 00:00:00
img: /assets/blog/mysql-to-postgres.webp
img_alt: A MySQL database with a memory gauge in the red migrating via Spring Boot to a PostgreSQL database with a memory gauge in the green, with a stack of versioned Flyway migration files below
description: >-
  MySQL was using more memory than the app itself on a small EC2 instance. I moved to Postgres to claw some of it back — and used the migration as the moment to hand schema ownership over to Flyway instead of letting Hibernate manage it. Here's the reasoning and what the change actually involved.
tags:
  - Spring Boot
  - PostgreSQL
  - Flyway
  - AWS
  - Database
---

## TL;DR

MySQL was sitting at around 458 MiB on a small EC2 instance shared with the app and Nginx — more than the app's own footprint. Postgres idles at around 51 MiB doing the same job. I took the migration as the opportunity to stop letting Hibernate manage the schema and moved to Flyway with a hand-written initial migration, validated against the JPA entities at startup. The swap itself is mostly a connector change; the schema-ownership shift is the part worth understanding.

---

## The Problem

My [cupcake orders service](https://github.com/leighwest/orders) runs on a single small EC2 instance, sharing memory with Nginx and the database container. On that kind of box, memory is the constraint that matters — there's no spare headroom to absorb a process that wants half a gigabyte at idle.

MySQL was that process. At rest, doing nothing but waiting for the occasional order, the MySQL container sat at around 458 MiB. The Spring Boot app at the time was around 448 MiB. So the database — which for this app does very little — was using as much memory as the application it existed to serve.

That's the kind of imbalance that's easy to ignore until you're trying to fit everything onto a smaller, cheaper instance. The plan was to drop down an instance size, and MySQL's footprint was the thing standing in the way.

---

## Why Postgres?

The decision came down to two things, the first of which carried most of the weight.

**Memory.** This was the immediate driver. Postgres idles considerably lighter than MySQL for a workload this small. After the migration, the database container settled at around 51 MiB — roughly a 400 MiB saving, on an instance where 400 MiB is a meaningful fraction of the total. That alone justified the move.

**The migration cost was low.** The app talks to the database through JPA, which abstracts away most of the differences between the two. There's no raw SQL scattered through the codebase tying me to MySQL-specific syntax. That meant the bulk of the change was swapping a driver and a dialect, not rewriting queries.

I considered SQLite briefly, since it would use even less memory. But it would have meant the integration tests no longer ran against something production-shaped — Testcontainers spinning up a real Postgres is part of what makes those tests trustworthy. Dropping to an embedded file database would have traded away that realism for memory I didn't strictly need. Postgres was the right balance.

| Metric    | MySQL container (idle) | Postgres container (idle) |
| ------    | ---------------------- | ------------------------- |
| Memory    | ~458 MiB               | ~51 MiB                   |

---

## The Migration

### Dependencies

Out with the MySQL connector, in with the Postgres driver and Flyway:

```xml
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
    <scope>runtime</scope>
</dependency>
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-core</artifactId>
</dependency>
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-database-postgresql</artifactId>
</dependency>
```

The `flyway-database-postgresql` dependency is the one that isn't obvious. As of Flyway 10, the database-specific support is split out into its own modules rather than bundled into `flyway-core`. With Spring Boot 3.3 pulling in Flyway 10, leaving it out means Flyway can't recognise Postgres and fails at startup.

### Connection config

The datasource URL, dialect, and driver all point at Postgres now:

```properties
spring.datasource.url=jdbc:postgresql://${POSTGRES_HOST}:5432/orders
spring.datasource.username=postgres
spring.datasource.password=${POSTGRES_PASSWORD}
spring.jpa.hibernate.ddl-auto=validate
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
```

The line that matters most here is `spring.jpa.hibernate.ddl-auto=validate`. That's the schema-ownership decision, and it's worth its own section.

---

## Handing Schema Ownership to Flyway

The old setup let Hibernate manage the schema — `ddl-auto` was doing the work of creating and updating tables from the entity classes. That's convenient during early development, but it has real downsides for anything past that point. `ddl-auto=update` will add columns but won't drop them, so the schema accumulates unused columns. It runs against your live data on every startup, which is not something you want happening unsupervised in production. And it leaves no record of how the schema got to where it is — there's no history, just the current state inferred from your entities.

Flyway fixes all three. The schema is defined in versioned migration scripts that run in order, exactly once each, with a recorded history of what ran and when. The migration is the source of truth, and it's reviewable in a pull request like any other code.

So the migration to Postgres was also the moment to switch schema ownership. `ddl-auto=validate` tells Hibernate to stop managing the schema entirely and instead check, at startup, that the schema Flyway produced matches what the entities expect. If they disagree, the application refuses to start.

The schema itself lives in `V1__init.sql` — a plain SQL file Flyway runs against an empty database on first boot:

```sql
CREATE TABLE customer (
    id         BIGSERIAL PRIMARY KEY,
    first_name VARCHAR(255) NOT NULL,
    surname    VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL UNIQUE
);

CREATE INDEX idx_email ON customer(email);

CREATE TABLE orders (
    id                 BIGSERIAL PRIMARY KEY,
    uuid               UUID NOT NULL UNIQUE,
    customer_order_ref BIGINT NOT NULL,
    customer_id        BIGINT NOT NULL REFERENCES customer(id),
    address_id         BIGINT REFERENCES address(id),
    total_price        NUMERIC(19, 2) NOT NULL
);
```

> Trimmed to two tables — the full script defines the rest.

### The catch: validate means validate

Here's the part that's easy to underestimate. Once Hibernate is in `validate` mode, your migration script and your entity classes have to agree *exactly*. Hibernate isn't generating the schema anymore — it's checking the one Flyway built against the one it would have built, and any mismatch is a startup failure rather than a silent fix.

That's a different working model than `ddl-auto=update`. Under `update`, a discrepancy between an entity and the schema gets quietly papered over — Hibernate adds the missing column and moves on. Under `validate`, the same discrepancy stops the application cold. Which is the point: it surfaces drift immediately instead of letting it accumulate. But it does mean the first few startups after switching are an exercise in reconciling the two definitions until they line up — column types, nullability, constraints, naming all have to match what Hibernate derives from the entities.

The naming is the easiest place to trip. Spring's default naming strategy maps a camelCase Java field like `customerOrderRef` to a snake_case column `customer_order_ref`. The migration script has to use the snake_case form, because that's what Hibernate will be looking for when it validates. Get the casing wrong in the SQL and the validation fails with a complaint about a missing column, even though the column is right there under a slightly different name.

Once the script and the entities agree, the startup is clean and stays clean — and from then on every schema change is a new numbered migration rather than a guess about what Hibernate might do.

---

## Tests

The integration tests already used Testcontainers, so the change there was small: swap the MySQL container for a Postgres one.

```java
static {
    POSTGRES_CONTAINER = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
            .withDatabaseName("orders")
            .withUsername("postgres")
            .withPassword("password");

    POSTGRES_CONTAINER.start();
}

@DynamicPropertySource
public static void dynamicPropertySource(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES_CONTAINER::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES_CONTAINER::getUsername);
    registry.add("spring.datasource.password", POSTGRES_CONTAINER::getPassword);
    registry.add("spring.jpa.properties.hibernate.dialect",
            () -> "org.hibernate.dialect.PostgreSQLDialect");
}
```

The `postgres:16-alpine` image starts in a couple of seconds and matches what runs in production closely enough to catch dialect-specific issues that the in-memory H2 database used by the unit tests would miss. The MySQL-specific workaround the old setup needed — a flag to disable native AIO so the container would start under WSL — is gone, since it was a MySQL container quirk that doesn't apply to Postgres.

The unit and service tests still run against H2. They test logic, not database behaviour, so they don't need a real engine. (I've written about [that two-layer testing setup separately](/blog/testing-spring-boot-sqs) — H2 for the fast logic tests, Testcontainers for the realistic ones.)

---

## Local and Prod Parity

The local Docker Compose setup runs a Postgres container so development matches production. In prod, the same image runs with a healthcheck so the app waits for the database to actually be ready before starting:

```yaml
postgres:
  container_name: postgres
  image: postgres:16-alpine
  restart: unless-stopped
  environment:
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    POSTGRES_DB: orders
  healthcheck:
    test: [ "CMD", "pg_isready", "-U", "postgres" ]
    interval: 5s
    timeout: 3s
    retries: 10

orders:
  container_name: orders
  image: ${ORDERS_IMAGE}
  depends_on:
    postgres:
      condition: service_healthy
  restart: unless-stopped
```

The `depends_on: condition: service_healthy` is a small but satisfying cleanup. The previous setup relied on the connection pool retrying indefinitely until the database came up — the app would start, fail to connect, and keep banging on the door until Postgres answered. It worked, but it was a workaround for a startup ordering problem.

`pg_isready` plus `condition: service_healthy` solves the ordering properly: Docker doesn't start the app container until the database container reports healthy. No retry loop, no connection errors in the logs during startup, no app process spinning while it waits. The dependency is declared, and Docker enforces it.

---

## Was It Worth It?

For this project, clearly yes — the memory saving was the whole point, and it's precisely what the migration achieved. The database container went from being the heaviest thing on the instance to one of the lightest, which made dropping to a smaller instance size viable.

But the database swap is almost the less interesting half of the change. The more durable win is the move to Flyway. Letting Hibernate manage a schema is fine right up until it isn't, and the migration to Postgres was a natural, low-risk moment to put proper schema versioning in place — versioned, reviewable, with a recorded history, validated against the entities on every startup. That's the part I'd keep even if I'd stayed on MySQL.

If you're running MySQL on a memory-constrained box for a workload that doesn't need it, Postgres is worth a look. And whatever database you're on, if Hibernate is still managing your schema, the switch to a migration tool is worth making before the schema gets complicated enough that the switch is painful.

> *This post covers the database half of a larger piece of work. The same change set also bumped the app to Java 21 and tuned the JVM — that's a [separate post](/blog/spring-boot-java-21-virtual-threads). The code referenced here is tagged [v1.3.0](https://github.com/leighwest/orders/tree/v1.3.0).*
