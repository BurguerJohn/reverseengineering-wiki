# Explorer rounds

An automated loop that tests the wiki and fills it at the same time. Each round, a subagent with no context explores https://reverseengineering.wiki, picks a public GitHub repository on a subject the wiki lacks, publishes from it with the bot account (PatientStepper99, direct publishing), and reports what was hard, what works and what to change. Then the gateway is improved from that report before the next round.

Decisions taken during the loop are listed per round, with the reason, so the owner can review and undo them.

## Round 1: OpenRCT2 (RollerCoaster Tycoon 2)

- Published: Format:Sawyer chunk encoding, Software:RollerCoaster Tycoon 2 and 1, Format:SV6/DAT/TD6 (RollerCoaster Tycoon 2), 18 facts, a Python Sawyer decoder (MIT-0), a link to OpenRCT2 (GPL-3.0).
- Fixed (0.7.6): duplicate check (same-batch pages, mentions are not duplicates), dry-run quota used the trust level from the start of the session, huge dry-run answers, missing `format`/`tool` scope levels, export_header with types from other pages, code titles with language names, match=any hint, release-binaries note.
- Rejected: all-or-nothing batches (MediaWiki has no transactions; a dry run that matches the real run covers it).
- Pending, decided for round 2: correcting a published fact, a software page showing its formats, listing pages by namespace.

## Round 2: StormLib (Blizzard MPQ archives)

- Published: Format:MPQ (MoPaQ), Library:StormLib, 18 facts (header, hash/block tables, crypt table, string hash, keys, compression), a Python MPQ reader tested against mpyq's sample archives, an open question, the StormLib link (MIT).
- Left out on purpose: Blizzard's signature keys, contents of the sample replay (player names).
- Shipped before it (0.7.7): edit_fact (a corrected claim goes back to "claimed"), read lists a subject's connected general pages, search with query "*" browses a type.
- Fixed for round 3 (0.7.8): export_header wrote empty enums for the documented {"0": "Name"} form; link_repo lists the repository on every subject; read honors section with format wikitext; identify and lookup_binary return the Code pages of what they found; test_vectors and samples are standard fields on every fact; the content policy says which "keys" are fine (algorithm constants, keys derived from public strings) and which are not (secret keys, private signing keys).
- Found while testing: MediaWiki's own limit (90 edits, 8 moves a minute per user) could break a 50-operation batch halfway; agents write only through the gateway, which has its own quota, so the agent group no longer has MediaWiki's limit.
- Rejected: a separate coverage map (browse with "*" and the connected general pages cover it).

## Round 3: Pan Docs (Game Boy)

- Published: Platform:Game Boy (+ topic Memory bank controllers), Format:Game Boy ROM image, 13 facts (cartridge header, checksums, MBC quirks, OAM DMA signature, tiles), a ROM header parser tested on the MIT-licensed dmg-acid2 and cgb-acid2 test ROMs, an edit linking SNES and Game Boy tile formats, the Pan Docs link (CC0).
- Left out on purpose: facts on commercial games (no license on the pret repositories, no legitimately obtained ROMs), licensee tables and audio/PPU timing (too much to summarize without copying tables).
- Its main point: the wiki was built for Windows executables. Fixed for round 5 (0.7.9): fixed hardware addresses are facts on the Platform page (`address.kind = "hardware"`, scope platform); export_header writes them as #defines; export_symbols takes a platform and writes Ghidra/IDA scripts with absolute addresses; `tool: "sym"` writes bank:address files (RGBDS, emulators) from banked facts.
- Also fixed: dry runs list the exact titles first (code pages, facts); a fact sent to a topic page says it went to the subject page; topic summaries no longer start with "Topic page of"; identify finds a pattern inside a published signature (?? on either side); struct fields take bits [{bit, name, notes}]; the "only you wrote this" note says it is the account; add_code and create_page document their title rules.
- Deferred: importing whole disassembly symbol maps for banked ROMs (needs a licensed source and Build pages for ROMs; the .sym export is the first step), per-signature "matched N builds" counters.

## Round 4: id Software's DOOM source release

- Published: Software:Doom, Format:WAD (Doom engine), Format:Doom demo (LMP), Format:Doom savegame (DSG), 29 facts (WAD layout, map lumps, rndtable and finesine signatures, ticcmd/state/mobjinfo, demo encoding), a low-confidence note with leads for retail DOS builds, a WAD inspector tested on the Freedoom IWADs (BSD, checksum-verified), the DOOM link (GPL-2.0).
- Left out on purpose: retail DOOM.EXE addresses (no legitimate binary), DMX/MUS sound formats (not in the release), long action-function tables (copying).
- Fixed for round 6 (0.8.0): dry runs return a check_id and publish_checked publishes exactly what was checked (the agent resent 40 KB three times); export_symbols with a subject writes a Ghidra/IDA script that finds the subject's signature facts in the user's own binary and names unique matches (its first suggestion: knowledge from source releases applies to any build); export_header handles typed arrays (int16_t[2][4], char[8]), descriptive enum value and type names, and size "variable" structs; code titles no longer repeat the language; read honors max_tokens for code; clearer size_min/size_max error; engine pages and the underscore-in-titles behavior are documented.
- Caught by checking the output: the first version of the scan script had an invalid Python escape and would not have run in Ghidra; a unit test now pins the generated text.
- Rejected: a gaps/requests board (the owner decided against global lists), an engine/family relation (the infobox engine field does it).

## Round 5: sotn-decomp (Castlevania: Symphony of the Night, PlayStation)

- Published: Platform:PlayStation, Format:PS-X EXE, Library:Psy-Q SDK, Technique:Matching decompilation, Software:Castlevania: Symphony of the Night, a Build for the US release (partial identity: the project publishes SHA-1), facts (EXE header, RAM layout, Entity and stage structs, engine globals), a 69-name symbol map, notes, the sotn-decomp link (AGPL-3.0).
- Rejected by the agent on licensing grounds: devilution (non-open-source license, leaked debug symbols), pokered/oot/melee (no license on GitHub).
- Its main finding was a real bug: PlayStation addresses are absolute (0x80010DF4); stored as rva, every exported label would have landed at base + address, and va facts were not applied at all.
- Fixed for round 7 (0.8.1): add_symbols takes va (relative to the build's image_base when declared, else kept absolute), warns when an rva looks absolute, and takes overlay; exported Ghidra/IDA scripts place absolute addresses with toAddr / as is, va facts included; JSON exports addresses in hex. Builds take sha1, md5 and crc32, and lookup_binary finds them. export_header declares every struct first, orders structs by by-value dependencies, keeps function pointers and struct pointers; enum values that are not identifiers get a warning at publication. release_date takes YYYY and YYYY-MM; register_build documents its title pattern; the content policy says a licensed symbol map is data.
- Found while testing: concurrent processes on the SQLite databases failed at once with "database is locked" (the CLI next to the running gateway); both databases now wait up to 10 s.
- Deferred: importing a decompilation's symbol file straight from a repository URL; cross-region address lookup (signature scans cover the main case).

## Round 6: id Software's Quake source release

- Published: Software:Quake and 7 format pages (PAK, BSP v29, MDL, SPR, WAD2, Progs.dat/QuakeC, LIT), 32 facts (layouts, lump numbers, the 66 QuakeC opcodes, CRC-16 with a test vector, header CRCs by game, FTEQCC fingerprint), corrections to its own over-claims after testing on LibreQuake (BSD) data, the Quake link (GPL-2.0).
- Left out on purpose: the registered-version check (licensing circumvention), retail executables (no legitimate binaries), Half-Life/Quake II formats (untested).
- Two complaints were not server bugs: link_repo's `page` replaced the subject list instead of adding to it (now it adds), and publish_checked "missing": round 6 started right after a deploy, before the bot connection refreshed its tool list. From now on a new round starts only after the new tools are visible.
- Fixed for round 7 (0.8.2): negative enum values (they produced invalid C), enum type names without trailing underscores, link_repo takes a declared license when GitHub's detector finds none, identify matches strings exactly or by long substrings (common words made it noisy), evidence takes structured source citations (repo, commit, path, lines), create_page says when MediaWiki capitalized the first letter, read invites a parser on format pages that have none, the per-session log line is written after the client introduces itself (it always said "?" and "no elicitation"). The content policy says number-to-name tables (opcodes, builtins, IDs) are data.
- Rejected: running submitted code against samples on the server (a code execution risk); a "most wanted" list (the owner declined global lists).
- Next round's budget: about 60 operations (40 made agents drop finished facts).

## Round 7: libdragon (Nintendo 64 SDK)

- Published: Platform:Nintendo 64 (memory map, boot, Joybus), Format:Nintendo 64 ROM image (byte orders, header, IPL3/CIC), Library:Libdragon (ROM layout, compressed ELF, SYMT symbol tables), 43 facts (8 register blocks, 11 hardware addresses, boot hand-over, CIC 6102 hash with test vectors, SYMT structs, `_start` signature), a tested ROM inspector, a note of open leads; tested on libdragon's own IPL3 binaries and an AGPL homebrew ROM.
- Left out on purpose: a port of an unlicensed checksum tool (only its results as test vectors), Nintendo bootcode bytes, unverified libultra names (marked unverified).
- Fixed for round 9 (0.8.3): struct size_min alone (a lower bound) and size_max alone; evidence lines take lists ("26-34, 98-101"); enum constants that collide across a header get the enum's name in front, names with a leading digit stay whole (`_64GB_LINK_CABLE`, it lost "64"); hardware addresses typed by a register struct on the page become typed pointers (`((volatile vi_regs *)0xA4400000)`), single registers stay plain addresses; platform scripts skip addresses without a memory block and say which, and name address-carrying behaviours after the fact; fact keys with leading underscores (`_start`) no longer give titles with a leading space; link_repo's answer says when a repository is archived; search matches short words ("N64") at word starts, not inside "Win64"; dry-run page lists use stored titles once; edit_section edits the infobox (section "Infobox", fields to set, empty removes).
- Not a new address kind: fixed RAM the boot code fills is "hardware" (the same in every program); documented.
- Deferred: applying struct types to platform labels in Ghidra scripts (the header import covers it for now).

## Round 8: CPython .pyc and marshal

- Published: Format:PYC (Python compiled bytecode) and Format:Marshal (Python), 21 facts (magic numbers 2.7-3.15, header layouts, source hash with test vectors, a code-object signature that matched 13,772 of 13,773 standard-library pycs, marshal type codes, code-object field order by version, location and exception table encodings), two tested code pages (a cross-version pyc reader identical to marshal.loads on 13,773 files; table decoders with 0 mismatches on 310k code objects), a runtime confirmation on Library:Microsoft C Runtime, an open question on Python packers. Found an error in CPython's own internal docs (varint example).
- Fixed for round 10 (0.8.4): identify honours the mask of magic facts (masked bytes are wildcards: versioned magics like pyc matched nothing); export_header wraps structs in #pragma pack(1) when alignment is 1, packed is true or a field sits off its natural alignment (the header's offsets disagreed with what a compiler would do); code files keep their trailing newline and read (format files) gives each file's SHA-256; the decompiler-output filter needs a decompiler-only token (v0..v3 and a1 alone are ordinary names: a textbook SipHash was blocked), and names what it saw and where; edit_section replace keeps the blank lines after the heading; add_code shows its length limits in the schema.
- Also: the e2e suite's call helper does not throw on tool errors, and a batch hit the test account's quota silently; the newer feature tests now run as an established account and check batch results.
- Rejected: keeping underscores in fact titles (MediaWiki stores _ as a space; data.name keeps the identifier); a justification parameter for the decompiler filter (it would be a bypass; the filter is narrower instead); a summary line for many NOT_FOUND errors (the message is already clear). Not reproduced: the dry-run preview collapsing blank lines in code.
- After deploying: reindex, so existing magic facts get their masks.

## Round 9: zlib

- Published: Library:Zlib, Format:DEFLATE, Format:Zlib stream, Format:Gzip, 32 facts (9 table signatures for both pointer widths, an exact version identifier from two bytes of the `lext` table covering all 64 releases 1.2.0-develop and checked on 5 real binaries, missing copyright banners in MSVC builds, Adler-32 constant, inflate_mode values, z_stream on Win64 measured through ctypes, header magic per level, checksums with test vectors), a tested table scanner, corrections on Format:MPQ and Library:StormLib (its bundled zlib is 1.2.5).
- Fixed for round 11 (0.8.5): four-part version numbers in a list with shorter versions ("1.2.0 to 1.3.0.1") or in backticks are versions, not IP addresses (other contexts still block, e.g. "client 2.1 connected from <IP>"); link_repo really replaces the entry of the same URL (entries are bulleted, so the old one was never removed and a corrected license added a second entry), and its no-license warning says how to fix a license the detector missed; search "*" with a subject lists that subject's pages (it listed the whole wiki); signatures take signature_offset (the name sits before or after the match) and exported scripts apply it; data tables (kind global) compiled in several times get every copy named (_2, _3), functions stay unique-only unless LABEL_ALL; identification facts take a standard `table` field.
- Rejected: identify reading a version out of a match's wildcard bytes (the table field plus the code page cover it).
- Single-author problem (agents cannot verify each other's work: every test round writes as the same account): a decision for the owner (a second bot account or real external agents).

## Round 10: the MSVC C++ ABI (LLVM and Wine sources)

- Published: Platform:Microsoft Visual C++ ABI with topics RTTI, Name decoration and C++ exception handling (COL, TypeDescriptor, CHD, BCD, ThrowInfo, CatchableType, FH3 tables, the FH4 header and compressed integers), 20 facts with source citations and runtime tests on binaries the agent compiled (x86, x64, /d2FH4-), an `__ehhandler$` thunk signature (54/54 in its build, 286/286 in msvcp140.dll), a tested RTTI scanner, Software:Notepad++ with a build and 222 vftables named from RTTI, edits linking EDF5 and the C runtime page.
- Incident: the agent launched the owner's installed Notepad++ (`--version`) and tried to kill the process (blocked by the permission system). Nothing from the machine was published. From round 11 the prompt forbids launching installed applications and killing processes, and anything identifying the machine owner.
- Fixed for round 12 (0.8.6): link_repo accepts SPDX expressions ("Apache-2.0 WITH LLVM-exception") and reports a license file GitHub did not recognize ("unrecognized (LICENSE.TXT)") instead of "no license"; observed_in keeps free text as written (it was title-normalized: "??_7 MAP" became "?? 7 MAP") and normalizes only page titles; inline <code>, <sub>, <sup>, <br>, <kbd> pass through Markdown (they were escaped, breaking tables); identify ignores byte patterns that overlap only on wildcards (any "E8 ?? ?? ?? ??" fitted anywhere); signatures with `multiple: true` (thunks) get every hit named; enum values keyed by characters ("'A'"); naming conventions for secondary vftables, deleting destructors and thunks documented.
- Rejected: one shared source string per page in generated scripts (the per-symbol fact title is what a reviewer checks; 222 symbols are 22 KB); dry runs of topic pages before their parent exists (a batch does it).

## Round 11: Lua (PUC-Rio reference implementation)

- Published: Library:Lua, Format:Lua bytecode (headers 5.1-5.5, prototype layout, the opposite varint conventions of 5.4 and 5.5, constant tags, loader errors), Software:VLC media player, 29 facts (opcode enums per version, luaP_opmodes signatures that name the exact minor version, 5.5.0 vs 5.5.1 differing in one byte, the 0x03/0x13 tag swap between 5.3 and 5.4), two tested code pages (an embedded-Lua finder and a 5.1-5.5 chunk disassembler that parses VLC's 36 chunks to the last byte), two open questions. Built every release tag with MSVC and tested cross-version loading.
- Fixed for round 13 (0.8.7): identify matches version banners across versions (digits masked on both sides: "$LuaVersion: Lua 5.4.6 ... 1994-2023" now matches a published 5.1 banner) and published strings may use * wildcards; an enum whose constants collide gets the enum's name on all of its constants (only some were prefixed); ask states its limits (question 400, context 600 characters) and refuses longer text instead of cutting it; signature facts take a name for their label, and the meaning of signature_offset/offset is in the add_fact description; code pages read as Markdown list each file's SHA-256.
- Rejected: a dry-run warning when the "matches" text says "before" but the offset is positive (guessing from prose; the description now says it plainly).
