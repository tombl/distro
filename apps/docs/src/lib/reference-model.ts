// Turns a `@deno/doc` Document into the entries the reference page renders.
// Each exported symbol becomes one entry with a `.d.ts`-style signature,
// its JSDoc split into a summary and the rest, and the documented members
// listed separately. Options interfaces used by exactly one function are
// folded into that function's parameter list instead of getting an entry.

import type {
  ClassDef,
  Declaration,
  Document,
  FunctionDef,
  InterfaceDef,
  JsDoc,
  ParamDef,
  TsTypeDef,
  TsTypeParamDef,
} from "@deno/doc";

import { referenceGroupId, referenceSymbolId, type ReferenceSection } from "./reference-packages";

type Symbol = Document["symbols"][number];

export interface Example {
  description: string;
  code: string;
  language: string;
}

export interface Member {
  id: string;
  name: string;
  signature: string;
  doc?: string;
  examples: Example[];
}

export interface Parameter {
  name: string;
  doc?: string;
  // Present when the parameter's options interface is folded in here.
  fields?: { id: string; name: string; members: Member[] };
}

export interface Entry {
  id: string;
  name: string;
  signature: string;
  summary?: string;
  doc?: string;
  returns?: string;
  examples: Example[];
  parameters: Parameter[];
  members: Member[];
}

export interface Group {
  id: string;
  title: string;
  description: string;
  entries: Entry[];
}

const MAX_SIGNATURE_LINE = 80;

function typeParams(params: TsTypeParamDef[] | undefined): string {
  if (!params?.length) return "";
  return `<${params
    .map(({ name, constraint, default: defaultType }) => {
      const constrained = constraint ? `${name} extends ${typeText(constraint)}` : name;
      return defaultType ? `${constrained} = ${typeText(defaultType)}` : constrained;
    })
    .join(", ")}>`;
}

function typeArgs(types: TsTypeDef[] | undefined): string {
  return types?.length ? `<${types.map(typeText).join(", ")}>` : "";
}

function typeText(type: TsTypeDef | undefined): string {
  if (!type) return "unknown";

  switch (type.kind) {
    case "typeRef":
      return `${type.value.typeName}${typeArgs(type.value.typeParams)}`;
    case "union":
      return type.value.map(typeText).join(" | ");
    case "intersection":
      return type.value.map(typeText).join(" & ");
    case "array":
      return `${typeText(type.value)}[]`;
    case "tuple":
      return `[${type.value.map(typeText).join(", ")}]`;
    case "typeOperator":
      return `${type.value.operator} ${typeText(type.value.tsType)}`;
    case "parenthesized":
      return `(${typeText(type.value)})`;
    case "rest":
      return `...${typeText(type.value)}`;
    case "optional":
      return `${typeText(type.value)}?`;
    case "typeQuery":
      return `typeof ${type.value}`;
    case "this":
      return "this";
    case "fnOrConstructor":
      return `${type.value.constructor ? "new " : ""}${typeParams(type.value.typeParams)}(${type.value.params.map(paramText).join(", ")}) => ${typeText(type.value.tsType)}`;
    case "conditional":
      return `${typeText(type.value.checkType)} extends ${typeText(type.value.extendsType)} ? ${typeText(type.value.trueType)} : ${typeText(type.value.falseType)}`;
    case "indexedAccess":
      return `${typeText(type.value.objType)}[${typeText(type.value.indexType)}]`;
    case "importType":
      return `import(${JSON.stringify(type.value.specifier)})${type.value.qualifier ? `.${type.value.qualifier}` : ""}`;
    case "infer":
      return `infer ${type.value.typeParam.name}`;
    case "typeLiteral": {
      const { properties = [], methods = [], indexSignatures = [] } = type.value;
      const parts = [
        ...indexSignatures.map(
          (signature) =>
            `${signature.readonly ? "readonly " : ""}[${signature.params.map(paramText).join(", ")}]: ${typeText(signature.tsType)}`,
        ),
        ...properties.map(
          (property) =>
            `${property.readonly ? "readonly " : ""}${memberName(property)}${property.optional ? "?" : ""}: ${typeText(property.tsType)}`,
        ),
        ...methods.map(
          (method) =>
            `${memberName(method)}${method.optional ? "?" : ""}${typeParams(method.typeParams)}(${method.params.map(paramText).join(", ")}): ${typeText(method.returnType)}`,
        ),
      ];
      return parts.length ? `{ ${parts.join("; ")} }` : "{}";
    }
    case "mapped":
      return "{ … }";
    case "typePredicate":
      return `${type.value.asserts ? "asserts " : ""}${type.value.param.type === "this" ? "this" : type.value.param.name}${type.value.type ? ` is ${typeText(type.value.type)}` : ""}`;
    case "keyword":
      return type.value;
    case "literal":
      if (type.value.kind === "string") return JSON.stringify(type.value.string);
      if (type.value.kind === "template") return `\`${type.repr ?? ""}\``;
      return type.repr ?? "literal";
  }
}

function paramName(param: ParamDef): string {
  if (param.kind === "assign") return paramName(param.left);
  if (param.kind === "rest") return `...${paramName(param.arg)}`;
  if (param.kind === "identifier") return param.name;
  if (param.kind === "array")
    return `[${param.elements.map((item) => (item ? paramName(item) : "")).join(", ")}]`;
  return `{ ${param.props.map((prop) => ("key" in prop ? prop.key : "…")).join(", ")} }`;
}

// Computed keys such as `[machinePlugin]` keep their brackets.
function memberName(member: { name: string; computed?: true }): string {
  return member.computed ? `[${member.name}]` : member.name;
}

function paramText(param: ParamDef): string {
  if (param.kind === "assign") return `${paramText(param.left)} = ${param.right}`;
  if (param.kind === "rest") {
    const type = param.tsType ?? paramType(param.arg);
    return `...${paramName(param.arg)}${type ? `: ${typeText(type)}` : ""}`;
  }
  return `${paramName(param)}${param.optional ? "?" : ""}: ${typeText(param.tsType)}`;
}

function paramType(param: ParamDef): TsTypeDef | undefined {
  if (param.kind === "assign") return paramType(param.left);
  if (param.kind === "rest") return undefined;
  return param.tsType;
}

// `head(a, b): tail`, broken one parameter per line when it gets too long.
function callText(head: string, params: ParamDef[], tail: string, indent = ""): string {
  const inline = `${head}(${params.map(paramText).join(", ")})${tail}`;
  if (indent.length + inline.length <= MAX_SIGNATURE_LINE || params.length === 0) return inline;
  const lines = params.map((param) => `${indent}  ${paramText(param)},`);
  return `${head}(\n${lines.join("\n")}\n${indent})${tail}`;
}

function functionText(name: string, def: FunctionDef): string {
  return callText(
    `${def.isAsync ? "async " : ""}function ${name}${typeParams(def.typeParams)}`,
    def.params,
    `: ${typeText(def.returnType)}`,
  );
}

// @example tags carry one description line followed by a fenced code block,
// matching the Deno standard library convention.
function parseExamples(jsDoc: JsDoc | undefined): Example[] {
  const examples: Example[] = [];
  for (const tag of jsDoc?.tags ?? []) {
    if (tag.kind !== "example") continue;
    const fence = /```(\w*)\n([\s\S]*?)```/;
    const match = tag.doc.match(fence);
    if (match) {
      examples.push({
        description: tag.doc.replace(fence, "").trim(),
        language: match[1] || "ts",
        code: match[2].trim(),
      });
    } else {
      examples.push({ description: "", code: tag.doc.trim(), language: "ts" });
    }
  }
  return examples;
}

function memberEntry(owner: string, name: string, signature: string, jsDoc?: JsDoc): Member {
  return {
    id: referenceSymbolId(`${owner}.${name}`),
    name,
    signature,
    doc: jsDoc?.doc,
    examples: parseExamples(jsDoc),
  };
}

function interfaceMembers(owner: string, def: InterfaceDef): Member[] {
  return [
    ...(def.indexSignatures ?? []).map((signature) => {
      const key = `[${signature.params.map(paramText).join(", ")}]`;
      return memberEntry(
        owner,
        key,
        `${signature.readonly ? "readonly " : ""}${key}: ${typeText(signature.tsType)}`,
        (signature as { jsDoc?: JsDoc }).jsDoc,
      );
    }),
    ...(def.properties ?? []).map((property) =>
      memberEntry(
        owner,
        memberName(property),
        `${property.readonly ? "readonly " : ""}${memberName(property)}${property.optional ? "?" : ""}: ${typeText(property.tsType)}`,
        property.jsDoc,
      ),
    ),
    ...(def.methods ?? []).map((method) =>
      memberEntry(
        owner,
        memberName(method),
        callText(
          `${memberName(method)}${method.optional ? "?" : ""}${typeParams(method.typeParams)}`,
          method.params,
          `: ${typeText(method.returnType)}`,
          "  ",
        ),
        method.jsDoc,
      ),
    ),
  ];
}

function classMembers(owner: string, def: ClassDef): Member[] {
  return [
    ...(def.constructors ?? []).map((constructor) =>
      memberEntry(
        owner,
        "constructor",
        callText("constructor", constructor.params, "", "  "),
        constructor.jsDoc,
      ),
    ),
    ...(def.properties ?? []).map((property) =>
      memberEntry(
        owner,
        property.name,
        `${property.isStatic ? "static " : ""}${property.readonly ? "readonly " : ""}${property.name}${property.optional ? "?" : ""}: ${typeText(property.tsType)}`,
        property.jsDoc,
      ),
    ),
    ...(def.methods ?? []).map((method) => {
      // 0.202 emits `functionDef`; its published type still calls this `def`.
      const functionDef =
        (method as unknown as { functionDef?: FunctionDef }).functionDef ?? method.def;
      return memberEntry(
        owner,
        method.name,
        callText(
          `${method.isStatic ? "static " : ""}${method.name}${typeParams(functionDef.typeParams)}`,
          functionDef.params,
          `: ${typeText(functionDef.returnType)}`,
          "  ",
        ),
        method.jsDoc,
      );
    }),
  ];
}

function declarationMembers(owner: string, declaration: Declaration): Member[] {
  switch (declaration.kind) {
    case "interface":
      return interfaceMembers(owner, declaration.def);
    case "class":
      return classMembers(owner, declaration.def);
    case "enum":
      return declaration.enumDef.members.map((member) =>
        memberEntry(owner, member.name, member.name, member.jsDoc),
      );
    default:
      return [];
  }
}

function block(head: string, members: Member[], separator = ";"): string {
  if (members.length === 0) return `${head} {}`;
  const body = members.map(({ signature }) =>
    signature
      .split("\n")
      .map((line, index) => (index === 0 ? `  ${line}` : line))
      .join("\n"),
  );
  return `${head} {\n${body.map((line) => `${line}${separator}`).join("\n")}\n}`;
}

function declarationText(name: string, declaration: Declaration): string {
  switch (declaration.kind) {
    case "function":
      return functionText(name, declaration.def);
    case "variable":
      return `${declaration.def.kind} ${name}: ${typeText(declaration.def.tsType)}`;
    case "typeAlias": {
      const head = `type ${name}${typeParams(declaration.def.typeParams)}`;
      const type = declaration.def.tsType;
      if (type.kind === "fnOrConstructor") {
        return callText(
          `${head} = ${type.value.constructor ? "new " : ""}`,
          type.value.params,
          ` => ${typeText(type.value.tsType)}`,
        );
      }
      return `${head} = ${typeText(type)}`;
    }
    case "interface": {
      const def = declaration.def;
      const extendsText = def.extends?.length
        ? ` extends ${def.extends.map(typeText).join(", ")}`
        : "";
      return block(
        `interface ${name}${typeParams(def.typeParams)}${extendsText}`,
        interfaceMembers(name, def),
      );
    }
    case "class": {
      const def = declaration.def;
      const extendsText = def.extends ? ` extends ${def.extends}` : "";
      return block(
        `class ${name}${typeParams(def.typeParams)}${extendsText}`,
        classMembers(name, def),
      );
    }
    case "enum":
      return block(`enum ${name}`, declarationMembers(name, declaration), ",");
    case "namespace":
      return `namespace ${name}`;
    case "reference":
      return name;
  }
}

// Every type name referenced anywhere in the document, with its count.
function typeReferenceCounts(node: unknown, counts = new Map<string, number>()) {
  if (Array.isArray(node)) {
    for (const item of node) typeReferenceCounts(item, counts);
  } else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.kind === "typeRef") {
      const name = (record.value as { typeName: string }).typeName;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const value of Object.values(record)) typeReferenceCounts(value, counts);
  }
  return counts;
}

function callableParams(declaration: Declaration): ParamDef[] {
  if (declaration.kind === "function") return declaration.def.params;
  if (declaration.kind === "typeAlias" && declaration.def.tsType.kind === "fnOrConstructor") {
    return declaration.def.tsType.value.params;
  }
  return [];
}

function splitSummary(doc: string | undefined): { summary?: string; rest?: string } {
  if (!doc) return {};
  const [summary, ...rest] = doc.trim().split(/\n{2,}/);
  return { summary, rest: rest.length ? rest.join("\n\n") : undefined };
}

// Only plain records of properties are folded into a parameter. Anything
// with inheritance, methods, or signatures keeps its own entry.
function isOptionsRecord(symbol: Symbol): boolean {
  return symbol.declarations.every(
    (declaration) =>
      declaration.kind === "interface" &&
      !declaration.def.extends?.length &&
      !declaration.def.methods?.length &&
      !declaration.def.indexSignatures?.length &&
      !declaration.def.callSignatures?.length,
  );
}

export function buildReference(pkg: ReferenceSection, document: Document): Group[] {
  const symbolsByName = new Map(document.symbols.map((symbol) => [symbol.name, symbol]));
  const referenceCounts = typeReferenceCounts(document.symbols);

  // An options interface referenced once, as a parameter of a top-level
  // function, is documented inside that function's entry.
  const folded = new Map<string, Symbol>();
  for (const symbol of document.symbols) {
    for (const declaration of symbol.declarations) {
      for (const param of callableParams(declaration)) {
        const type = paramType(param);
        if (type?.kind !== "typeRef") continue;
        const target = symbolsByName.get(type.value.typeName);
        if (target && isOptionsRecord(target) && referenceCounts.get(target.name) === 1) {
          folded.set(target.name, target);
        }
      }
    }
  }

  // Overloads and value/type pairs share one entry: their signatures are
  // shown together and the first documented declaration supplies the prose.
  function entry(symbol: Symbol): Entry {
    const declarations = symbol.declarations;
    const documented =
      declarations.find((declaration) => declaration.jsDoc?.doc) ?? declarations[0];
    const jsDoc = documented.jsDoc;
    const { summary, rest } = splitSummary(jsDoc?.doc);
    const paramDocs = new Map(
      (jsDoc?.tags ?? []).flatMap((tag) =>
        tag.kind === "param" && tag.doc ? [[tag.name, tag.doc] as const] : [],
      ),
    );
    const returns = (jsDoc?.tags ?? []).find((tag) => tag.kind === "return")?.doc;
    const callable = declarations.find((declaration) => callableParams(declaration).length > 0);
    const parameters: Parameter[] = (callable ? callableParams(callable) : []).flatMap((param) => {
      const name = paramName(param);
      const type = paramType(param);
      const target = type?.kind === "typeRef" ? folded.get(type.value.typeName) : undefined;
      const fields = target && {
        id: referenceSymbolId(target.name),
        name: target.name,
        members: target.declarations.flatMap((d) => declarationMembers(target.name, d)),
      };
      const doc = paramDocs.get(name);
      return doc || fields ? [{ name, doc, fields }] : [];
    });
    return {
      id: referenceSymbolId(symbol.name),
      name: symbol.name,
      signature: declarations.map((d) => declarationText(symbol.name, d)).join("\n\n"),
      summary,
      doc: rest,
      returns,
      examples: declarations.flatMap((declaration) => parseExamples(declaration.jsDoc)),
      parameters,
      members: declarations
        .flatMap((declaration) => declarationMembers(symbol.name, declaration))
        .filter((member) => member.doc || member.examples.length),
    };
  }

  const grouped = new Set<string>(pkg.groups.flatMap((group) => group.symbols));
  const groups = [
    ...pkg.groups.map((group) => ({ ...group, symbols: group.symbols as readonly string[] })),
    {
      title: "Other exports",
      description: "Types and lower-level exports not grouped above.",
      symbols: document.symbols.map(({ name }) => name).filter((name) => !grouped.has(name)),
    },
  ];
  return groups
    .map((group) => ({
      id: referenceGroupId(group.title),
      title: group.title,
      description: group.description,
      entries: group.symbols.flatMap((name) => {
        const symbol = symbolsByName.get(name);
        return symbol && !folded.has(name) ? [entry(symbol)] : [];
      }),
    }))
    .filter((group) => group.entries.length > 0);
}

/** Every anchor ID the reference page renders for these groups. */
export function renderedAnchors(groups: Group[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    ids.add(group.id);
    for (const entry of group.entries) {
      ids.add(entry.id);
      for (const member of entry.members) ids.add(member.id);
      for (const parameter of entry.parameters) {
        if (!parameter.fields) continue;
        ids.add(parameter.fields.id);
        for (const member of parameter.fields.members) ids.add(member.id);
      }
    }
  }
  return ids;
}

// Resolves `{@link Target}` and signature type names to anchors on the page.
// The target is a top-level symbol (`GuestAgent`) or a member (`GuestAgent.mount`).
// A member without its own rendered anchor links to its symbol instead.
export function linkResolver(document: Document, anchors: Set<string>) {
  const symbols = new Set(document.symbols.map((symbol) => symbol.name));
  return (target: string): string | undefined => {
    if (/^https?:/i.test(target)) return target;
    const [symbolName, member] = target.split(".");
    if (!symbols.has(symbolName)) return undefined;
    const candidates = member
      ? [referenceSymbolId(`${symbolName}.${member}`), referenceSymbolId(symbolName)]
      : [referenceSymbolId(symbolName)];
    const id = candidates.find((candidate) => anchors.has(candidate));
    return id === undefined ? undefined : `#${id}`;
  };
}
