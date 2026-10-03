# Settings preflight

`core.settings.preview` reads the selected live node under the workflow lock and prepares a separate native `NodeSettings` candidate. It takes the same `{projectId,workflowId?,nodeId,patches}` arguments and typed edits as `core.settings.patch`. It is a READ operation and does not require a mutation precondition. Root workflow patch/preview targets are rejected; an individual node, component or metanode must be selected.

```json
{
  "projectId":"discovered-project-id",
  "nodeId":"0:3",
  "patches":[
    {"path":["model","count"],"value":4},
    {"path":["model","seed"],"type":"xlong","value":"9007199254740993"}
  ]
}
```

Read `core.settings.get` and installed node documentation before choosing paths. The bridge does not invent defaults or hardcode node templates. A successful preview is advisory: `core.settings.patch` still reads current settings, prepares and validates a fresh candidate, and checks the bound context's expected revisions immediately before loading it.

## Response

The result includes `preview:true`, `applied:false`, `nativeDispatch:"not_started"`, the unchanged current `state`, the redacted candidate `settings`, `diff`, `changedFields`, `beforeSettingsValidation`, candidate `settingsValidation`, `validForSave`, `accepted`, `resetImpact`, `coverage`, and `unknown`.

Each diff row has the exact `path`, `kind` (`add` or `update`), `requestedType`, `createParents`, `changed`, and typed `before`/`after` entries. A missing entry is `{exists:false}`; existing string null has `value:null`, while an empty string has `value:""`. Long values remain decimal strings; special floating values remain `"NaN"`, `"Infinity"` or `"-Infinity"`. Native arrays are represented as config groups with native indexed entries and `array-size`. Protected values remain present in the native candidate but are omitted from returned settings/diffs. Protected entries and traversal through protected groups cannot be patched.

`accepted` means that the detached envelope serialized and the installed container's native validation-only method returned successfully. For native nodes this validates common envelope settings and model settings. `validForSave` uses those same checks for native nodes and remains false for components/metanodes whose child model settings are outside this candidate's coverage. `validForSave:true` does not verify a saved file, custom view settings, resolved flow-variable overrides or future node serializer behavior.

Schema/type/range/protected-path errors are rejected as malformed requests. A well-formed patch that fails native validation returns `accepted:false`, its diff and bounded validation error details. Apply rejects that candidate with `NODE_SETTINGS_INVALID`, `applied:false`, `nativeDispatch:"not_started"`; it never reaches live loading. A preview that passes native validation can still fail at actual apply time when revisions, dependencies or node implementation behavior differ.

## Shared rules

- 1–1000 patch objects; 1–64 exact, nonempty string path keys. Unknown patch fields, duplicate paths, and ancestor/descendant paths in one request are rejected.
- Existing scalar types remain exact. New keys require a supported explicit native type. A supplied `type:null`, unsupported type, or group replacement is rejected.
- Missing config groups require `createParents:true` on that edit. Native `addConfigBase` creates them in the candidate only.
- `xlong` and `longArray` input values require signed decimal strings within the signed 64-bit range. This intentionally rejects numeric long inputs to prevent lost JavaScript precision. Other integer scalar types retain their existing integer-or-decimal-string parsing and enforce their native ranges.
- Native array replacement must match existing element types when those are present; nonempty arbitrary subtrees cannot be replaced by array setters. An empty native array carries no element-type metadata, so the result explicitly reports `unknown-empty-native-array` and relies on model validation. A native null array is a completely empty config group and cannot be distinguished from an arbitrary empty config group. The existing explicit-array-type replacement allowance is preserved and reports `unknown-null-native-array-or-empty-config-group`.
- String null and empty strings remain distinct. Boolean and character values are strict; `xchar` is exactly one UTF-16 character. Finite float overflow is rejected. Nonfinite values require an explicit special-value string.

## Reset impact and non-mutation boundary

Preview never calls `loadNodeSettings`, reset, configure, execute or apply-time mutation policy. Both preview and apply use `SettingsPreview.prepare`, which copies each native typed entry into a separate full envelope before editing. `SettingsHealth.validate` invokes the installed validation-only container method and serializes the detached candidate to a discarded stream. It does not load candidate values into the live model. KNIME 5.12's `ConfigBase.copyTo` shares/reparents scalar entries, and serialized copying drops transient strings, so neither is used for this detached copy.

`resetImpact` reports potential resets for the selected node, reachable successor nodes and enclosing containers plus their descendants/successors. It includes current states, is capped at 10,000 entries with explicit truncation, and always sets `exact:false` and `resetPerformed:false`. It deliberately includes a no-op patch because a later native load may still reset a node. Loops, branches, component internals, effective variables and input-dependent configure behavior mean exact native reset effects remain unknown.

Native validation implementations are assumed to honor KNIME's validation-only contract. Arbitrary third-party validators are not sandboxed; live acceptance must verify unchanged executed state, revisions and table identity/data on the supported fixture.

## Verification

`node --test tests/settings-preview.test.mjs` checks dispatch/preparation boundaries only. It explicitly does not claim runtime model preservation.

After building the integrated bridge, run the same test with `KNIME_SETTINGS_JVM_TEST=1` to compile/run `SettingsPreviewProbe`. That probe uses native detached `NodeSettings`, verifies full-envelope preservation, original parent pointers, encrypted passwords/transient strings, redaction, exact types, null/empty/special-float/64-bit encodings, generated int roundtrips and rejected malformed patches. It never creates or opens a workflow. The harness extracts the installed core/core.util libraries into a disposable class directory because their signed split packages require OSGi in the application; a plain JVM rejects those packages when loaded directly from the mixed-signer JARs. A test-only `NodeLogger` stub bypasses OSGi logging startup and fails on unexpected native warnings; the settings classes and entry implementations remain native. Installed libraries are only read.

The serial live acceptance harness must execute a disposable fixture, preview both valid and native-invalid patches, reject an invalid apply, and compare before/after node states/messages, context revisions, output identity/schema/full table values and dirty state. It must also apply a valid typed repair and verify saved/reopened Unicode settings. Those live checks remain separate from detached/JVM proof.
