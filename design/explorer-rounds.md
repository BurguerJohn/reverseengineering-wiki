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
