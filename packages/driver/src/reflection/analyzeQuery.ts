import { ArrayCodec } from "../codecs/array";
import { AT_LEAST_ONE, AT_MOST_ONE, MANY, ONE } from "../codecs/consts";
import { EnumCodec } from "../codecs/enum";
import type { ICodec } from "../codecs/ifaces";
import { ScalarCodec } from "../codecs/ifaces";
import { NamedTupleCodec } from "../codecs/namedtuple";
import { ObjectCodec } from "../codecs/object";
import { MultiRangeCodec, RangeCodec } from "../codecs/range";
import { NullCodec } from "../codecs/codecs";
import { SetCodec } from "../codecs/set";
import { TupleCodec } from "../codecs/tuple";
import { Cardinality, OutputFormat } from "../ifaces";
import { Options, Session } from "../options";
import type { Client, BaseClientPool } from "../baseClient";

type QueryType = {
  args: string;
  result: string;
  cardinality: Cardinality;
  query: string;
  imports: Set<string>;
};

export async function analyzeQuery(
  client: Client,
  query: string
): Promise<QueryType> {
  const [cardinality, inCodec, outCodec] = await parseQuery(client, query);

  const imports = new Set<string>();
  const args = walkCodec(inCodec, {
    indent: "",
    optionalNulls: true,
    readonly: true,
    imports,
  });

  const result = applyCardinalityToTsType(
    walkCodec(outCodec, {
      indent: "",
      optionalNulls: false,
      readonly: false,
      imports,
    }),
    cardinality
  );

  return {
    result,
    args,
    cardinality,
    query,
    imports,
  };
}

export async function parseQuery(client: Client, query: string) {
  const pool: BaseClientPool = (client as any).pool;

  const holder = await pool.acquireHolder(Options.defaults());
  try {
    const cxn = await holder._getConnection();
    return await cxn._parse(
      query,
      OutputFormat.BINARY,
      Cardinality.MANY,
      Session.defaults()
    );
  } finally {
    await holder.release();
  }
}

export function applyCardinalityToTsType(
  type: string,
  cardinality: Cardinality
): string {
  switch (cardinality) {
    case Cardinality.MANY:
      return `${type}[]`;
    case Cardinality.ONE:
      return type;
    case Cardinality.AT_MOST_ONE:
      return `${type} | null`;
    case Cardinality.AT_LEAST_ONE:
      return `[(${type}), ...(${type})[]]`;
  }
  throw Error(`unexpected cardinality: ${cardinality}`);
}

// type AtLeastOne<T> = [T, ...T[]];

export { walkCodec as walkCodecToTsType };
function walkCodec(
  codec: ICodec,
  ctx: {
    indent: string;
    optionalNulls: boolean;
    readonly: boolean;
    imports: Set<string>;
  }
): string {
  if (codec instanceof NullCodec) {
    return "null";
  }
  if (codec instanceof ScalarCodec) {
    if (codec instanceof EnumCodec) {
      return `(${codec.values.map((val) => JSON.stringify(val)).join(" | ")})`;
    }
    if (codec.importedType) {
      ctx.imports.add(codec.tsType);
    }
    return codec.tsType;
  }
  if (codec instanceof ObjectCodec || codec instanceof NamedTupleCodec) {
    const fields =
      codec instanceof ObjectCodec
        ? codec.getFields()
        : codec.getNames().map((name) => ({ name, cardinality: ONE }));
    const subCodecs = codec.getSubcodecs();
    const objectShape = `{\n${fields
      .map((field, i) => {
        let subCodec = subCodecs[i];
        if (subCodec instanceof SetCodec) {
          if (
            !(field.cardinality === MANY || field.cardinality === AT_LEAST_ONE)
          ) {
            throw Error("subcodec is SetCodec, but upper cardinality is one");
          }
          subCodec = subCodec.getSubcodecs()[0];
        }
        return `${ctx.indent}  ${JSON.stringify(field.name)}${
          ctx.optionalNulls && field.cardinality === AT_MOST_ONE ? "?" : ""
        }: ${applyCardinalityToTsType(
          walkCodec(subCodec, { ...ctx, indent: ctx.indent + "  " }),
          field.cardinality
        )};`;
      })
      .join("\n")}\n${ctx.indent}}`;
    return ctx.readonly ? `Readonly<${objectShape}>` : objectShape;
  }
  if (codec instanceof ArrayCodec) {
    return `${ctx.readonly ? "readonly " : ""}${walkCodec(
      codec.getSubcodecs()[0],
      ctx
    )}[]`;
  }
  if (codec instanceof TupleCodec) {
    return `${ctx.readonly ? "readonly " : ""}[${codec
      .getSubcodecs()
      .map((subCodec) => walkCodec(subCodec, ctx))
      .join(", ")}]`;
  }
  if (codec instanceof RangeCodec) {
    const subCodec = codec.getSubcodecs()[0];
    if (!(subCodec instanceof ScalarCodec)) {
      throw Error("expected range subtype to be scalar type");
    }
    ctx.imports.add("Range");
    return `Range<${walkCodec(subCodec, ctx)}>`;
  }
  if (codec instanceof MultiRangeCodec) {
    const subCodec = codec.getSubcodecs()[0];
    if (!(subCodec instanceof ScalarCodec)) {
      throw Error("expected multirange subtype to be scalar type");
    }
    ctx.imports.add("MultiRange");
    return `MultiRange<${walkCodec(subCodec, ctx)}>`;
  }
  throw Error(`Unexpected codec kind: ${codec.getKind()}`);
}
