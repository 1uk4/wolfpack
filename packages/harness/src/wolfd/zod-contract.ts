/**
 * A readable JSON-Schema-like rendering of a zod 3 schema (the engine and memory packages use zod 3; zod-to-json-schema is not a
 * dependency of this package). Read-only display of the "locked output contract" of a pipeline prompt: not used to validate anything.
 */
type Def = { typeName?: string; [k: string]: unknown };
type ZodLike = { _def: Def; description?: string };

export function zodContract(schema: unknown): unknown {
  const z = schema as ZodLike;
  const d = z._def;
  const withDoc = (o: Record<string, unknown>) => (z.description ? { ...o, description: z.description } : o);
  switch (d.typeName) {
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" };
      for (const c of (d.checks as { kind: string; value?: number }[] | undefined) ?? []) {
        if (c.kind === "min") out.minLength = c.value;
        if (c.kind === "max") out.maxLength = c.value;
      }
      return withDoc(out);
    }
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      for (const c of (d.checks as { kind: string; value?: number }[] | undefined) ?? []) {
        if (c.kind === "int") out.type = "integer";
        if (c.kind === "min") out.minimum = c.value;
        if (c.kind === "max") out.maximum = c.value;
      }
      return withDoc(out);
    }
    case "ZodBoolean":
      return withDoc({ type: "boolean" });
    case "ZodLiteral":
      return withDoc({ const: d.value });
    case "ZodEnum":
      return withDoc({ enum: d.values });
    case "ZodNativeEnum":
      return withDoc({ enum: Object.values(d.values as object) });
    case "ZodArray":
      return withDoc({ type: "array", items: zodContract(d.type) });
    case "ZodRecord":
      return withDoc({ type: "object", additionalProperties: zodContract(d.valueType) });
    case "ZodOptional":
    case "ZodDefault":
    case "ZodCatch":
      return zodContract(d.innerType);
    case "ZodNullable":
      return { anyOf: [zodContract(d.innerType), { type: "null" }] };
    case "ZodEffects":
      return zodContract(d.schema);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { anyOf: (Array.isArray(d.options) ? d.options : [...(d.options as Map<unknown, unknown>).values()]).map(zodContract) };
    case "ZodObject": {
      const shape = (typeof d.shape === "function" ? (d.shape as () => Record<string, ZodLike>)() : d.shape) as Record<string, ZodLike>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodContract(v);
        if (!isOptional(v)) required.push(k);
      }
      return withDoc({ type: "object", properties, required });
    }
    default:
      return {};
  }
}

function isOptional(z: ZodLike): boolean {
  const t = z._def.typeName;
  if (t === "ZodOptional" || t === "ZodDefault") return true;
  if (t === "ZodNullable" || t === "ZodEffects") return isOptional((z._def.innerType ?? z._def.schema) as ZodLike);
  return false;
}

/** The pretty-printed contract. */
export function contractText(schema: unknown): string {
  return JSON.stringify(zodContract(schema), null, 2);
}
