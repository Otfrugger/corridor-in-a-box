# Adding an onboarding exporter

A receiving anchor onboards the business that pays through it. Until receivers
accept a business onboarding profile directly, the business fills in each
receiver's own form. An **exporter** maps one `BusinessProfile` onto one
receiver's form, so the business describes itself once and every receiver gets
its fields in the names and shape it expects.

The interface, the profile type and the registry live in
`packages/adapter-kit/src/onboarding.ts` and are exported from
`@corridor/adapter-kit`. A worked example is
[`examples/onboarding/example-receiver-exporter.ts`](../examples/onboarding/example-receiver-exporter.ts).

## The profile

`BusinessProfile` is deliberately small: legal and trading name, registration
number, country of incorporation (ISO 3166-1 alpha-2), optional incorporation
date, tax id and website, a registered address, and a list of contacts each
tagged `primary`, `compliance`, `finance` or `technical`. If a receiver needs
something the profile does not carry, propose adding the field in your PR rather
than smuggling it in through the exporter.

## The contract

```ts
export interface OnboardingExporter {
  readonly id: string; // ^[a-z0-9-]+$, unique per registry
  readonly receiver: string; // human-readable receiver name
  export(profile: BusinessProfile): Outcome<ReceiverForm, ExporterError>;
}
```

`ReceiverForm` is `Record<string, string>`: the receiver's own field names
mapped to values. Exporters follow the same rule as the rest of the engine: they
never throw, they return `Outcome`. When the profile is missing something the
receiver's form requires, return `err({ code: "PROFILE_INCOMPLETE", message })`
naming what is missing. Leave optional form fields out instead of sending empty
strings.

An exporter is a pure mapping. It does not call the receiver, store anything,
or log profile values; the profile is business PII.

## Registering

```ts
import { createExporterRegistry } from "@corridor/adapter-kit";
import { exampleReceiverExporter } from "./example-receiver-exporter";

const exporters = createExporterRegistry();
const registered = exporters.register(exampleReceiverExporter);
if (!registered.ok) throw new Error(registered.error.message);

const form = exporters.export("example-receiver", profile);
```

`register` fails with `EXPORTER_INVALID` for an id that does not match
`^[a-z0-9-]+$` and with `EXPORTER_DUPLICATE` when the id is already taken; the
first registration wins. `export` fails with `EXPORTER_UNKNOWN` for an id
nobody registered. `get(id)` and `ids()` are there for lookups and listings.

## Checklist for a new exporter

1. Copy `examples/onboarding/example-receiver-exporter.ts` and pick an id that
   names the receiver (for an anchor already wired as `custom:<id>`, reuse that
   id).
2. Map every field the receiver's form requires. Use the receiver's own field
   names exactly, and return `PROFILE_INCOMPLETE` for anything required that the
   profile lacks.
3. Add a test next to `tests/onboarding-exporter.test.ts` that registers the
   exporter, exports a sample profile and asserts the full form, plus one case
   for each `PROFILE_INCOMPLETE` path. Use fictional data and reserved example
   domains, never a real business.
4. Run `pnpm lint && pnpm typecheck && pnpm test`.
