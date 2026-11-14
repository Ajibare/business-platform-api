# Product Module Guide

## Adding a product module

1. Create module under `src/modules/products/<product>`.
2. Add database models under the product namespace.
3. Add services and controllers.
4. Add permissions.
5. Register product access.
6. Define API endpoints under the product prefix.
7. Write tests.

## Cross-module rules

A product module must not depend on another product module. Use platform contracts for shared capabilities.
