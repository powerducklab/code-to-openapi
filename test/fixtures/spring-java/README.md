# Spring Java scan fixture

This fixture uses Java 17 records, Spring Boot 3, Jakarta Bean Validation, and
Reactor for the SSE endpoint. Use **JDK 17 or newer** and **Maven 3.6.3 or newer**.

Verify the Java project separately from the TypeScript scanner tests:

```sh
mvn --batch-mode --no-transfer-progress -f test/fixtures/spring-java/pom.xml clean verify
```

The Maven parent manages dependency versions. The validation starter supplies
`@Valid` and `@NotBlank`; `reactor-core` supplies `Flux`. The web starter alone
does not supply these dependencies.

In VS Code, select a JDK 17+ project runtime and reload the Maven project after
changing its POM. A JDK 11 project runtime cannot compile records or Spring Boot 3.
This is a controller/DTO scan fixture, not a standalone bootable application.
