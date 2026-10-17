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
