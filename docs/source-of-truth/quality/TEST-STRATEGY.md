# Test Strategy

Every behavioral change must name its verification layer:

- Unit test for local routing, parsing, or policy behavior.
- Integration test for database or supervisor behavior.
- Live drill for model routing and provider behavior.
- Deployment activation check for production service changes.
