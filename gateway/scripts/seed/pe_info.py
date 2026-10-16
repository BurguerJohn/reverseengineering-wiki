"""Print the identity of a Windows PE file: what ReverseEngineering.wiki's lookup_binary and
register_build need (SHA-256, size, PE timestamp, image base), plus headers and
sections. Standard library only."""
import hashlib
import json
import struct
import sys

MACHINES = {0x14C: "i386", 0x8664: "x64", 0xAA64: "arm64", 0x1C4: "armnt"}


def pe_info(path):
    data = open(path, "rb").read()
    if data[:2] != b"MZ":
        raise ValueError("not a PE file: missing MZ signature")
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise ValueError("not a PE file: missing PE signature")
    coff = e_lfanew + 4
    machine, n_sections, timestamp, _, _, opt_size, characteristics = struct.unpack_from("<HHIIIHH", data, coff)
    opt = coff + 20
    (magic,) = struct.unpack_from("<H", data, opt)
    if magic == 0x20B:  # PE32+
        (image_base,) = struct.unpack_from("<Q", data, opt + 24)
    elif magic == 0x10B:  # PE32
        (image_base,) = struct.unpack_from("<I", data, opt + 28)
    else:
        raise ValueError("unknown optional header magic 0x%X" % magic)
    (entry_rva,) = struct.unpack_from("<I", data, opt + 16)
    sections = []
    for i in range(n_sections):
        off = opt + opt_size + i * 40
        name = data[off:off + 8].rstrip(b"\0").decode("ascii", "replace")
        vsize, rva, raw_size, raw_ptr = struct.unpack_from("<IIII", data, off + 8)
        sections.append({"name": name, "rva": "0x%X" % rva, "virtual_size": "0x%X" % vsize, "raw_size": "0x%X" % raw_size})
    return {
        "name": path.replace("\\", "/").rsplit("/", 1)[-1],
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "pe_timestamp": "0x%08X" % timestamp,
        "image_base": "0x%X" % image_base,
        "machine": MACHINES.get(machine, "0x%X" % machine),
        "format": "PE32+" if magic == 0x20B else "PE32",
        "dll": bool(characteristics & 0x2000),
        "entry_rva": "0x%X" % entry_rva,
        "sections": sections,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python pe_info.py <file.exe|file.dll>")
    print(json.dumps(pe_info(sys.argv[1]), indent=2))
