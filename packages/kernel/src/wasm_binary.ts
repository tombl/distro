// SPDX-License-Identifier: MIT

// The WebAssembly JavaScript API reports that an import is a memory, but not
// the memory's limits. Those live in the module's import section, so read the
// small part of the binary format that is needed to recover them.

export interface WasmMemoryType {
  address: "i32" | "i64";
  minimum: bigint;
  maximum?: bigint;
  shared: boolean;
}

export interface WasmMemoryImport {
  module: string;
  name: string;
  type: WasmMemoryType;
}

export interface WasmMemories {
  imports: WasmMemoryImport[];
  definitions: WasmMemoryType[];
}

export class WasmParseError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "WasmParseError";
  }
}

const text_decoder = new TextDecoder("utf-8", { fatal: true });

class Cursor {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0, end = bytes.length) {
    this.#bytes = bytes;
    this.#offset = offset;
    this.#end = end;
  }

  get done() {
    return this.#offset === this.#end;
  }

  get offset() {
    return this.#offset;
  }

  byte() {
    if (this.#offset === this.#end) this.fail("unexpected end of module");
    return this.#bytes[this.#offset++]!;
  }

  u32() {
    return Number(this.#unsigned(32));
  }

  u64() {
    return this.#unsigned(64);
  }

  #unsigned(bits: number) {
    let value = 0n;
    const bytes = Math.ceil(bits / 7);

    for (let i = 0; i < bytes; i++) {
      const byte = this.byte();
      const payload = byte & 0x7f;
      const remaining = bits - i * 7;
      if (remaining < 7 && payload >= 1 << remaining) {
        this.fail(`u${bits} LEB128 overflows`);
      }
      value |= BigInt(payload) << BigInt(i * 7);
      if (!(byte & 0x80)) return value;
    }

    this.fail(`u${bits} LEB128 is too long`);
  }

  // Heap types can be type indices encoded as s33. Their value is immaterial
  // here, but consuming the complete, bounded encoding lets us skip table and
  // global imports without parsing unrelated type sections.
  signed33(first: number) {
    let byte = first;
    for (let i = 0; i < 5; i++) {
      const payload = byte & 0x7f;
      const remaining = 33 - i * 7;
      if (!(byte & 0x80)) {
        if (remaining < 7) {
          const used = (1 << remaining) - 1;
          const unused = 0x7f ^ used;
          const sign = 1 << (remaining - 1);
          const extension = payload & sign ? unused : 0;
          if ((payload & unused) !== extension) {
            this.fail("s33 LEB128 overflows");
          }
        }
        return;
      }
      if (i === 4) this.fail("s33 LEB128 is too long");
      byte = this.byte();
    }
  }

  span() {
    const length = this.u32();
    const start = this.#offset;
    const end = start + length;
    if (end > this.#end) this.fail("span extends past its section");
    this.#offset = end;
    return new Cursor(this.#bytes, start, end);
  }

  text(): string {
    try {
      return text_decoder.decode(this.view());
    } catch {
      return this.fail("name is not valid UTF-8");
    }
  }

  text_span(): string {
    return this.span().text();
  }

  view() {
    return this.#bytes.subarray(this.#offset, this.#end);
  }

  expect_done(what: string) {
    if (!this.done) this.fail(`trailing bytes in ${what}`);
  }

  fail(message: string): never {
    throw new WasmParseError(message, this.#offset);
  }
}

function read_memory_type(bytes: Cursor): WasmMemoryType {
  const flags = bytes.byte();
  if (flags & ~0x07) bytes.fail("unknown memory limits flags");

  const has_maximum = !!(flags & 0x01);
  const shared = !!(flags & 0x02);
  const address = flags & 0x04 ? "i64" : "i32";
  const read_limit = address === "i64" ? () => bytes.u64() : () => BigInt(bytes.u32());
  const minimum = read_limit();
  const maximum = has_maximum ? read_limit() : undefined;

  return { address, minimum, maximum, shared };
}

function skip_reference_type(bytes: Cursor) {
  const type = bytes.byte();
  if (type === 0x63 || type === 0x64) {
    bytes.signed33(bytes.byte());
  } else if (type < 0x69 || type > 0x74) {
    bytes.fail("invalid reference type");
  }
}

function skip_value_type(bytes: Cursor) {
  const type = bytes.byte();
  if (type >= 0x7b && type <= 0x7f) return;
  if (type === 0x63 || type === 0x64) {
    bytes.signed33(bytes.byte());
  } else if (type < 0x69 || type > 0x74) {
    bytes.fail("invalid value type");
  }
}

function skip_limits(bytes: Cursor) {
  const flags = bytes.byte();
  if (flags & ~0x05) bytes.fail("unknown limits flags");
  const read_limit = flags & 0x04 ? () => bytes.u64() : () => bytes.u32();
  read_limit();
  if (flags & 0x01) read_limit();
}

function read_imports(bytes: Cursor, imports: WasmMemoryImport[]) {
  const count = bytes.u32();
  for (let i = 0; i < count; i++) {
    // Keep names as spans until we know this is a memory import. Typical Linux
    // modules have many function imports whose names this reader need not own.
    const module = bytes.span();
    const name = bytes.span();
    switch (bytes.byte()) {
      case 0x00: // function
        bytes.u32();
        break;
      case 0x01: // table
        skip_reference_type(bytes);
        skip_limits(bytes);
        break;
      case 0x02: // memory
        imports.push({
          module: module.text(),
          name: name.text(),
          type: read_memory_type(bytes),
        });
        break;
      case 0x03: // global
        skip_value_type(bytes);
        if (bytes.byte() > 1) bytes.fail("invalid global mutability");
        break;
      case 0x04: // tag
        if (bytes.byte() !== 0) bytes.fail("unknown tag attribute");
        bytes.u32();
        break;
      default:
        bytes.fail("unknown import type");
    }
  }
  bytes.expect_done("import section");
}

function read_definitions(bytes: Cursor, definitions: WasmMemoryType[]) {
  const count = bytes.u32();
  for (let i = 0; i < count; i++) definitions.push(read_memory_type(bytes));
  bytes.expect_done("memory section");
}

function read_header(module: Uint8Array) {
  const bytes = new Cursor(module);
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const expected of header) {
    if (bytes.byte() !== expected) bytes.fail("invalid WebAssembly header");
  }
  return bytes;
}

export function read_wasm_memories(module: Uint8Array): WasmMemories {
  const bytes = read_header(module);

  const memories: WasmMemories = { imports: [], definitions: [] };
  let saw_imports = false;
  let saw_definitions = false;
  while (!bytes.done) {
    const id = bytes.byte();
    const section = bytes.span();
    if (id === 2) {
      if (saw_imports) bytes.fail("duplicate import section");
      saw_imports = true;
      read_imports(section, memories.imports);
    } else if (id === 5) {
      if (saw_definitions) bytes.fail("duplicate memory section");
      saw_definitions = true;
      read_definitions(section, memories.definitions);
    }
  }

  return memories;
}

export interface WasmFunctionImport {
  module: string;
  name: string;
  /** Written as "i64,i64->i32"; null if the type is not a function type. */
  type: string | null;
}

const value_type_names: Record<number, string> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
};

function read_value_type(bytes: Cursor): string {
  const type = bytes.byte();
  const name = value_type_names[type];
  if (name) return name;
  if (type === 0x63 || type === 0x64) {
    bytes.signed33(bytes.byte());
  } else if (type < 0x69 || type > 0x74) {
    bytes.fail("invalid value type");
  }
  return "ref";
}

function read_storage_type(bytes: Cursor) {
  // Packed i8 and i16 fields are only valid in GC aggregates.
  const type = bytes.view()[0];
  if (type === 0x78 || type === 0x77) bytes.byte();
  else read_value_type(bytes);
  if (bytes.byte() > 1) bytes.fail("invalid field mutability");
}

// Returns a function type's signature, or null for a GC aggregate type, which
// no function import can name.
function read_composite_type(bytes: Cursor): string | null {
  switch (bytes.byte()) {
    case 0x60: {
      const params = Array.from({ length: bytes.u32() }, () => read_value_type(bytes));
      const results = Array.from({ length: bytes.u32() }, () => read_value_type(bytes));
      return `${params.join(",")}->${results.join(",")}`;
    }
    case 0x5f: {
      const count = bytes.u32();
      for (let i = 0; i < count; i++) read_storage_type(bytes);
      return null;
    }
    case 0x5e:
      read_storage_type(bytes);
      return null;
    default:
      return bytes.fail("unknown composite type");
  }
}

function read_sub_type(bytes: Cursor, types: (string | null)[]) {
  const form = bytes.view()[0];
  if (form === 0x50 || form === 0x4f) {
    bytes.byte();
    const supertypes = bytes.u32();
    for (let i = 0; i < supertypes; i++) bytes.u32();
  }
  types.push(read_composite_type(bytes));
}

function read_types(bytes: Cursor, types: (string | null)[]) {
  const count = bytes.u32();
  for (let i = 0; i < count; i++) {
    if (bytes.view()[0] === 0x4e) {
      bytes.byte();
      const members = bytes.u32();
      for (let j = 0; j < members; j++) read_sub_type(bytes, types);
    } else {
      read_sub_type(bytes, types);
    }
  }
  bytes.expect_done("type section");
}

/**
 * Reads the signature of every function import. The JavaScript API reports
 * an import's kind but not its type, and a mismatched signature would only
 * surface as a LinkError at instantiation.
 */
export function read_wasm_function_imports(module: Uint8Array): WasmFunctionImport[] {
  const bytes = read_header(module);
  const types: (string | null)[] = [];
  const imports: WasmFunctionImport[] = [];
  while (!bytes.done) {
    const id = bytes.byte();
    const section = bytes.span();
    if (id === 1) {
      read_types(section, types);
    } else if (id === 2) {
      const count = section.u32();
      for (let i = 0; i < count; i++) {
        const module = section.text_span();
        const name = section.text_span();
        const kind = section.byte();
        switch (kind) {
          case 0x00: {
            const index = section.u32();
            imports.push({ module, name, type: types[index] ?? null });
            break;
          }
          case 0x01:
            skip_reference_type(section);
            skip_limits(section);
            break;
          case 0x02:
            read_memory_type(section);
            break;
          case 0x03:
            skip_value_type(section);
            if (section.byte() > 1) section.fail("invalid global mutability");
            break;
          case 0x04:
            if (section.byte() !== 0) section.fail("unknown tag attribute");
            section.u32();
            break;
          default:
            section.fail("unknown import type");
        }
      }
      section.expect_done("import section");
      // The type section precedes the import section, and nothing after the
      // imports can add function imports.
      break;
    }
  }
  return imports;
}
