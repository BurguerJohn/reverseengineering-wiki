# Fact reference

How to write facts, symbol maps and the data the export tools turn into Ghidra/IDA scripts and C headers. The tool descriptions keep only what a call needs; this page has the details. A dry run (`dry_run: true`) checks a write and says what is missing, unknown or suspicious, so when in doubt, dry-run first.

## Fields by kind

`data` holds the kind's fields. Fields outside these get a warning (they are kept, but exports ignore them).

{{FACT_DATA_TABLE}}

Every kind also takes `test_vectors` and `samples` (below). Every fact needs `evidence` (one file per entry: `{type: "source", repo, commit, path, lines}` for code you read; `runtime_test`, `byte_pattern`, `comparison`… for what you checked) and a `confidence`. Give it a short `key` (the page title) when the claim is a sentence.

## Scope and subjects

- `scope.level` is the most general level where the claim holds: technique, platform, format, library, tool, software, build. Put a finding about a bundled library on the `Library:` page, not on the game.
- A topic subpage as subject (`Format:PE (Portable Executable)/Rich header`) stores the fact on the subject page and lists it on the topic page.
- A Format and a Library with the same name keep separate fact titles (`Fact:X (Library)/…` for the second).

## Addresses and builds

- An address belongs to one exact binary: `scope.level = "build"` and `scope.applies_to` = a `Build:` page or the SHA-256 of one of its files (also one registered earlier in the same batch). One address per fact; many names at once go in a symbol map.
- PE: `data.rva` (relative to the image base, never absolute), e.g. `"0x141230"`.
- Other binaries: `data.address = {kind, value}`:
  - `va` (fixed-address images, PlayStation, consoles): `"0x80012345"`; declare `image_base` on the build when it has one.
  - `file` (file offset): `"0x1A2B0"`.
  - `segmented` (16-bit/DOS): `"1000:5AFA"`, `"DS:00CC"`, `"seg2:00CC"`.
  - `banked` (cartridges): `"03:8000"`.
  - `wasm` (WebAssembly function index, imported functions counted first): `"func:123"`.
  - `hardware` (memory-mapped I/O, vectors, BIOS calls, the same in every program of a platform): `"0xFF46"`, on the `Platform:` page with `scope.level = "platform"`.
- Builds (`register_build`): file hashes and metadata, never the file. SHA-256 is best; consoles may use the SHA-1/MD5/CRC32 that ROM and disc databases publish; without the file, size plus PE timestamp or version text is a partial identity. A library's own DLL is a build of its `Library:` page (software `"Library:Name"`).

## Structs, typedefs and enums

- Struct fields: `{offset, size, type, name, notes?, bits?, condition?}`. Types as C spells them (`uint32_t`, `unsigned short`, `const char *`, `Foo *`); `uint8`, `u32`, `int16_le`, `uint32_be`, `f32` are read as stdint types with the byte order noted.
- `bits: [{bit: "0" or "4-5", name, notes?}]` for flags; `condition: "flags & 0x08"` for a field present only when a flag is set.
- Exact size unknown: `size_min` and/or `size_max`. Entries after a header or a trailing name: the last field typed `T[]` or `T[count_field]` (a C flexible array member; `size` is then the fixed part or `"variable"`). A field after a variable part can have an offset like `"4+length"`: it is written as a comment.
- Library types (`FT_Long`, `DWORD`, `j_common_ptr`): one `typedef` fact each (`{name, type}`), so headers use them instead of bytes.
- Layouts that differ by ABI: `data.abi` (`"win64"`, `"lp64"`, `"ilp32"`) on struct and typedef facts, one fact per ABI; `export_header` takes `abi`. Other variants of one layout (a 32- or 64-bit target of a file format, ANSI or Unicode): `data.variant`, and `export_header` takes `variant`.
- Enum values: `{"0": "NAME"}`, `{"NAME": "0x10"}`, `[{name, value, notes}]`, negative (`"-0x7000"`), 64-bit (`"0x4000000000000001"`, kept exact), character codes (`"'A'"`), ranges (`"0x80-0x9F"`: exported as the first value, with the range in a comment) and sums (`"0xEFFE0000 + 19970605"`, computed for you). Values written in decimal stay decimal in headers. Keep names C identifiers; explanations go in `notes`.

## Signatures, magics and strings

- Byte patterns: `"48 89 5C 24 ?? 57"` (`??` any byte). On a function or global: `data.signature`; or a `signature` fact with `pattern` and `matches` (and `name` for its label; `target: "function"` or `"data"` says what it names, so scripts create the function).
- The name goes at match address + `signature_offset` (function/global) or `offset` (signature fact), negative when the pattern starts inside the object.
- `multiple: true` names every match (thunks, inlined helpers); data tables compiled in several times get every copy named. A variant (an optional `endbr64` prefix) is a second fact with the same name.
- Make a pattern unique: test it on several builds and on unrelated binaries. The server warns when it overlaps another subject's facts (a bundled copy: say so in the claim; otherwise lengthen it).
- Magic: `bytes`, `offset`, `meaning`, optional `mask`; `relative_to` when the offset counts from a table or section, not the file start.
- Identification by exports or imports: list the names in `indicator` (comma-separated) with `method: "exports"`; `identify` also finds names in builds' symbol maps and code-like names in article text.
- String facts (ASCII) are byte signatures too: subject scripts name where the string sits (for a string with `*`, its longest fixed part of 8+ characters).
- Strings: `*` for a variable part and `?` for one character (`"fts5: ????-??-?? *"`) (`"Copyright (C) 1991-* The libjpeg-turbo Project"`); `identify` also matches versions and years with other digits.

## Test vectors and samples

- `test_vectors: [{input, expected}]` (hashes, checksums, ciphers, encodings): others rerun them.
- `samples: [{url, sha256, note}]` for public files, or `[{code: "Code:…", file, args, sha256}]` for a sample a published script generates.

## Names

Names are identifiers: write what MSVC prints as ``Foo::`vftable'{for `Bar'}`` as `Foo::vftable_for_Bar`, a deleting destructor as `Foo::scalar_deleting_dtor`, a thunk as `thunk_Foo_Bar`. Go, Rust and C++ paths stay whole (`runtime.main`, `net/http.(*Client).Do`).

## Symbol maps

- `add_symbols`: up to 5,000 names per call for one build (`rva`, or `va`, or `wasm_func`), each with `kind`, `confidence`, `source`, and when known `type` (a prototype or data type), `size` and `signature`. The same name again is a confirmation; a different name replaces the old one only with higher confidence.
- `import_symbols`: a decompilation project's symbol file read from its repository at a pinned commit (splat `symbol_addrs.txt` and linker lists, decomp-toolkit `symbols.txt` for GameCube/Wii, nm output, address/name pairs). Only names, addresses, sizes and types are taken, never code or comments; the build page records where they came from.
- Give functions their prototype (`data.prototype`, or `type` in a symbol map) and globals their type and size: build scripts apply them.

## Exports

- `export_header` (subject, optional build, abi, and `also` for pages or single type names it uses, e.g. `also: ["GUID"]`): every struct, enum, typedef and vtable fact as C; `warnings` lists what it could not express. Import it before a build script, so the types exist.
- `export_symbols`: with `build`, a Ghidra or IDA script (or JSON) naming every function and global of that exact binary, with types; with `subject` (and `also` for a parent library), a script that finds the subject's signatures in your binary; with `platform`, its hardware addresses; `tool: "scan"` (with subject) gives a standalone Python script listing where the subject's signatures, strings and file magics occur in any file (installers, archives, dumps); `tool: "sym"` writes `bank:address name` for banked ROMs; `tool: "wasm-names"` writes WebAssembly names into the module's name section.
- `symbols` with build and rva also tells where the same name is in other builds (another version or region).

## Batches and dry runs

- `batch`: up to 50 writes in dependency order (pages, topics, builds, facts/code/notes/symbols, edits, reviews); later operations may refer to what earlier ones create. A real run stops at the first error and says what was published and what did not run. A later `edit_section` with `replace` applies on top of what earlier operations of the same batch wrote on that page. Keep one call under ~20 KB of arguments.
- A dry run returns a `check_id`: `publish_checked` publishes exactly that. Pass `replace: {"3": {arguments}}` to correct an operation (`{"3": {tool, arguments}}` swaps its tool, `{"3": null}` drops it), or `amend: {"3": [{old, new}]}` for a small text fix (`all: true` when the text repeats); a used `check_id` returns what it published, so retrying after a lost answer is safe; `quiet: true` lists pages without their contents.
- Each write counts against the hourly quota (`account_status`); a batch over it is refused whole, and a dry run says how many operations fit now.
