# Type annotations

Hand-authored sidecars that tell the Aven adapter when a JSON object in the
corpus should render as a `Map` or a variant (`@Tag`), not as a record.

| Path                   | Role                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `types/<task-id>.json` | Per-task type annotations (schemaVersion 1)                         |
| `corpus/`              | Generated; **never** put annotations there — ingest wipes task dirs |

Ingest does not touch this tree. After `bun run ingest`, run:

```sh
bun run check-types
```

Design: `../.ai/corpus-type-annotations-draft.md` (rev 5) in the monorepo, or
the copy under the parent `clex` tree.

## Authoring checklist

1. Prefer **sparse paths** only — annotate the map or variant root, not whole
   record trees the default already handles.
2. `type` is an **Aven type string** in the **corpus subset** only: `Null`,
   `Bool`, `Int`, `Float`, `Text`, `Object`, `Array(T)`, `Map(Text|Int, T)`,
   `?T`, `T | U`, `@Tag`, `@Tag(T)`. Anything else fails as _unsupported in
   corpus annotations_.
3. **Maps:** choose key kind from the domain (word counts → `Text` keys; etl
   legacy scores → `Int` keys; IOU amounts → `Float` values).
4. **Variants:** always supply `encoding` (`tagField` or `exclusiveKey`). Never
   add task-specific branches in the generator. Constructor names in the type
   string and encoding must match.
5. **Nullability is only `?T`** (Aven spelling). Whole-value null (alphametics)
   → `"?Map(Text, Int)"`. Entry nulls → `Map(Text, ?Int)` or
   `Map(Text, Null | Object)` when the non-null side is not a single
   non-optional type. Nullability is written inside the type, at the level it
   applies to, so a nullable whole and nullable entries stay distinguishable.
6. **Never** annotate fixed-alphabet oracles such as `nucleotide-count`
   (`A,C,G,T`) as maps — they _validate_ as maps but are records. See design doc
   Appendix A.
7. **word-search** map values as `Map(Text, ?Object)` (or `Null | Object`) is an
   accepted **partial** fix: the inner location record stays opaque.
8. After editing, `bun run check-types` must be green.
9. When annotation files land, regenerate Aven suites and confirm the **suite
   oracle and contract prose both** show `Map` / `@Tag` (never one without the
   other).

## Minimal examples

Map:

```json
{
  "schemaVersion": 1,
  "task": "word-count",
  "positions": [{ "at": "countWords.expected", "type": "Map(Text, Int)" }]
}
```

Nullable whole map (alphametics):

```json
{
  "schemaVersion": 1,
  "task": "alphametics",
  "positions": [{ "at": "solve.expected", "type": "?Map(Text, Int)" }]
}
```

Variant (`tagField`):

```json
{
  "schemaVersion": 1,
  "task": "bank-account",
  "positions": [
    {
      "at": "bankAccount.arg.operations[]",
      "type": "@Open | @Deposit(Int)",
      "encoding": {
        "kind": "tagField",
        "field": "operation",
        "tags": {
          "open": { "ctor": "Open", "payload": { "from": "none" } },
          "deposit": {
            "ctor": "Deposit",
            "payload": { "from": "field", "name": "amount" }
          }
        }
      }
    }
  ]
}
```
