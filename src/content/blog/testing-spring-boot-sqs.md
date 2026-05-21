---
title: Testing a Spring Boot SQS App Without Hitting AWS
publishDate: 2026-05-02 00:00:00
img: /assets/blog/test-containers.webp
img_alt: A Docker container, database stack, and Spring Boot logo arranged in front of a code editor screen
description: |
  When your app connects to SQS on startup, running tests gets a little complicated. Here's how I set up H2 for unit tests, Testcontainers for integration tests, and stopped the SQS listener from trying to connect to AWS every time I ran the suite.
tags:
  - Spring Boot
  - Testing
  - SQS
  - Testcontainers
  - AWS
---

## TL;DR

Unit and service tests use H2. Integration tests use Testcontainers with a real MySQL instance. The SQS listener is mocked out so it doesn't try to connect to AWS on every test run. A few things needed fixing to get test data seeding to work.

---

## The Problem

Once I replaced Kafka with SQS in my [cupcake orders service](https://github.com/leighwest/orders), the test suite broke. The SQS listener starts polling on application startup — so every test run was attempting to connect to real AWS queues. Even if credentials are present, that's not behaviour you want in a test suite.

Beyond that, I had two slightly different problems to solve for two different test layers. For unit and service tests, I needed a lightweight in-memory database that spun up instantly. For integration tests, I needed something close enough to production to trust the results.

---

## Two Test Layers, Two Database Strategies

### H2 for unit and service tests

H2 is in-memory and starts in milliseconds. It's the right tool for tests that are checking logic, not database behaviour — service methods, validators, repository queries that don't depend on MySQL-specific syntax.

The catch is that H2 doesn't support all the same SQL as MySQL. If you have any dialect-specific queries hiding in your JPA, H2 will silently accept something MySQL would reject, or reject something MySQL would accept. So H2 is suitable for tests that don't care about the database, not for tests that are actually testing database behaviour.

```properties
# application-test.properties
spring.datasource.url=jdbc:h2:mem:myDb;DB_CLOSE_DELAY=-1
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect
spring.jpa.hibernate.ddl-auto=create-drop
spring.cloud.aws.credentials.access-key=test
spring.cloud.aws.credentials.secret-key=test
spring.cloud.aws.region.static=ap-southeast-4
sqs.order-created-queue=order-created
sqs.order-dispatched-queue=order-dispatched
```

`ddl-auto=create-drop` lets Hibernate create the schema from your entity classes on startup and drop it at the end. Fine for tests — you don't want schema state leaking between runs.

The dummy credentials (`test`/`test`) are needed because Spring Cloud AWS validates that credentials are present at startup. Without them you get a credentials provider exception before any test runs.

### Testcontainers for integration tests

For integration tests — the ones that go through the full HTTP stack via `@SpringBootTest` and `MockMvc` — I wanted a real MySQL instance, not H2. This catches the dialect-specific issues that H2 misses, and it's a closer match to what runs in production.

A MySQL container spins up, creates a fresh schema, and tears it down when the tests finish. It's slower than H2 but still fast enough — under 10 seconds to start.

The Testcontainers setup lives in an abstract base class that integration test classes extend. The container configuration is defined once and shared across any integration test class that needs it, rather than repeated in each one.

```java
@Sql(scripts = "/insertData.sql")
public abstract class AbstractionBaseTest {

    static final MySQLContainer<?> MY_SQL_CONTAINER;

    static {
        MY_SQL_CONTAINER = new MySQLContainer<>(DockerImageName.parse("mysql:8.2.0"))
                .withDatabaseName("order")
                .withUsername("root")
                .withPassword("password")
                .withEnv("MYSQL_USER", "MYSQL_ALLOW_EMPTY_PASSWORD")
                .withCommand("--skip-innodb-use-native-aio");

        MY_SQL_CONTAINER.start();
    }

    @DynamicPropertySource
    public static void dynamicPropertySource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", MY_SQL_CONTAINER::getJdbcUrl);
        registry.add("spring.datasource.name", MY_SQL_CONTAINER::getDatabaseName);
        registry.add("spring.datasource.username", MY_SQL_CONTAINER::getUsername);
        registry.add("spring.datasource.password", MY_SQL_CONTAINER::getPassword);
        registry.add("spring.jpa.properties.hibernate.dialect", () -> "org.hibernate.dialect.MySQLDialect");
    }
}
```

The `withCommand("--skip-innodb-use-native-aio")` flag is a WSL-specific workaround — MySQL's native AIO doesn't work on WSL and causes the container to fail on startup without it.

`@DynamicPropertySource` wires in the container's connection details at runtime — Testcontainers assigns a random port, so you can't hardcode it. These properties override whatever is in `application-test.properties` for the integration test layer.

The concrete test class handles its own `@SpringBootTest`, `@ActiveProfiles`, and `@MockBean` declarations:

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@Transactional
@ActiveProfiles("test")
public class OrderControllerIntTest extends AbstractionBaseTest {

    @MockBean
    private OrderRequestSqsPublisher orderRequestSqsPublisher;

    @MockBean
    private DispatchEventSqsListener dispatchEventSqsListener;

    // tests...
}
```

Each test class mocks what it needs — the base class doesn't impose any mocks on its subclasses.

---

## Stopping the SQS Listener

`@MockBean DispatchEventSqsListener` on the concrete test class replaces the listener bean with a no-op mock before Spring tries to start it. The listener never gets to the point of connecting to SQS — no polling loop, no connection attempt.

This is all that's needed. The mock bean is the solution.

---

## Seeding Test Data

Integration tests need data in the database to test against. I used `@Sql(scripts = "/insertData.sql")` on the base class so every test starts with a known set of cupcakes and customer records.

The SQL file needed a few fixes before it worked.

**No CREATE TABLE statements.** The file initially included `CREATE TABLE` SQL. Hibernate runs first — it creates the schema from the entity classes. By the time `@Sql` runs, the tables already exist. The `CREATE TABLE` statements fail with "table already exists". Remove them; just `INSERT` data.

**Snake_case column names.** Spring Boot's default naming strategy converts camelCase Java field names to snake_case column names. `cupcakeId` in your entity becomes `cupcake_id` in the database. Your `INSERT` statements need to use the column names as they actually exist in the schema — snake_case.

**Unquoted string values.** SQL string values need single quotes: `'Vanilla'`, not `Vanilla`. An unquoted string without quotes is interpreted as a column name. The error message isn't always obvious about this.

```sql
-- What it looked like before
INSERT INTO cupcakes (cupcakeId, name, price, quantity) VALUES (1, Vanilla, 3.50, 20);

-- What it needed to be
INSERT INTO cupcakes (cupcake_id, name, price, quantity) VALUES (1, 'Vanilla', 3.50, 20);
```

---

## One More Thing: DataLoader

The app has a `DataLoader` bean that inserts seed data on startup via `CommandLineRunner`. It's there for convenience during local development. In tests it was running on every boot and conflicting with the data from `insertData.sql` — or failing because the data already existed.

The fix is a `@Profile` annotation:

```java
@Component
@Profile("!test")
public class DataLoader implements CommandLineRunner {
    // ...
}
```

This tells Spring not to instantiate the bean when the `test` profile is active. The bean simply doesn't exist in the test context.

---

## What the Test Structure Looks Like

```
Unit / service tests     → H2, no Docker, no AWS
Integration tests        → Testcontainers (MySQL), @MockBean for SQS listener
```

Unit tests run fast. Integration tests run slower but are trustworthy. The SQS listener doesn't connect to anything in either case.

It's not an exotic setup, but getting the details right — the dummy credentials, the `ddl-auto`, the SQL file syntax, the `@Profile` on `DataLoader` — took longer than it should have. Hopefully this saves you some of that time.

> _The code referenced in this post is tagged [v1.0.0](https://github.com/leighwest/orders/tree/v1.0.0)._
