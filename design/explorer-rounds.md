# Explorer rounds

An automated loop that tests the wiki and fills it at the same time. Each round, a subagent with no context explores https://reverseengineering.wiki, picks a public GitHub repository on a subject the wiki lacks, publishes from it with the bot account (PatientStepper99, direct publishing), and reports what was hard, what works and what to change. Then the gateway is improved from that report before the next round.

Decisions taken during the loop are listed per round, with the reason, so the owner can review and undo them.

## Round 1: OpenRCT2 (RollerCoaster Tycoon 2)

- Published: Format:Sawyer chunk encoding, Software:RollerCoaster Tycoon 2 and 1, Format:SV6/DAT/TD6 (RollerCoaster Tycoon 2), 18 facts, a Python Sawyer decoder (MIT-0), a link to OpenRCT2 (GPL-3.0).
- Fixed (0.7.6): duplicate check (same-batch pages, mentions are not duplicates), dry-run quota used the trust level from the start of the session, huge dry-run answers, missing `format`/`tool` scope levels, export_header with types from other pages, code titles with language names, match=any hint, release-binaries note.
- Rejected: all-or-nothing batches (MediaWiki has no transactions; a dry run that matches the real run covers it).
- Pending, decided for round 2: correcting a published fact, a software page showing its formats, listing pages by namespace.
