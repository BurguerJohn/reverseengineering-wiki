"""List MSVC x64 RTTI classes in a PE32+ file: class name, TypeDescriptor,
CompleteObjectLocator (COL) and vtable RVAs. Standard library only.

x64 layout: TypeDescriptor = {pVFTable, spare, name}, so the name string starts
at +0x10. A COL has signature 1 and stores image-relative RVAs, including pSelf
(its own RVA), which makes matches unambiguous. The vtable starts right after
the 8-byte pointer to the COL."""
import re
import struct
import sys


def load(path):
    data = open(path, "rb").read()
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    coff = e_lfanew + 4
    _, n_sections, _, _, _, opt_size, _ = struct.unpack_from("<HHIIIHH", data, coff)
    opt = coff + 20
    (magic,) = struct.unpack_from("<H", data, opt)
    if magic != 0x20B:
        raise ValueError("this script handles PE32+ (x64) only")
    (image_base,) = struct.unpack_from("<Q", data, opt + 24)
    sections = []
    for i in range(n_sections):
        off = opt + opt_size + i * 40
        vsize, rva, raw_size, raw_ptr = struct.unpack_from("<IIII", data, off + 8)
        sections.append((rva, max(vsize, raw_size), raw_ptr, raw_size))
    return data, image_base, sections


def rva_to_off(sections, rva):
    for start, size, raw_ptr, raw_size in sections:
        if start <= rva < start + size and rva - start < raw_size:
            return raw_ptr + rva - start
    return None


def off_to_rva(sections, off):
    for start, _, raw_ptr, raw_size in sections:
        if raw_ptr <= off < raw_ptr + raw_size:
            return start + off - raw_ptr
    return None


def scan(path):
    data, image_base, sections = load(path)
    # TypeDescriptor RVA by class name.
    types = {}
    for m in re.finditer(rb"\.\?A[VU][\w@?$<>,]+@@\0", data):
        rva = off_to_rva(sections, m.start())
        if rva is not None:
            types[rva - 0x10] = m.group()[:-1].decode("ascii", "replace")
    # COLs: signature 1, pTypeDescriptor known, pSelf == own RVA.
    cols = {}
    for off in range(0, len(data) - 24, 4):
        sig, _, _, td, chd, self_rva = struct.unpack_from("<IIIiii", data, off)
        if sig == 1 and td in types:
            rva = off_to_rva(sections, off)
            if rva == self_rva:
                cols[rva] = td
    # vtables: an 8-byte pointer to the COL, followed by the virtual functions.
    results = []
    col_by_va = {image_base + rva: rva for rva in cols}
    for off in range(0, len(data) - 8, 8):
        (ptr,) = struct.unpack_from("<Q", data, off)
        if ptr in col_by_va:
            col = col_by_va[ptr]
            rva = off_to_rva(sections, off)
            if rva is not None:
                results.append((types[cols[col]], cols[col], col, rva + 8))
    return results


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python rtti_scan.py <x64 exe/dll>")
    for name, td, col, vtable in sorted(scan(sys.argv[1])):
        print("%-60s TD 0x%08X  COL 0x%08X  vtable 0x%08X" % (name, td, col, vtable))
