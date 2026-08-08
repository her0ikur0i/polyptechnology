import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import type { SecretResolver } from "./deepseek-adapter.js";
const references: Readonly<Record<string, string>> = {
  "secret://polyp/deepseek/api-key": "DEEPSEEK_API_KEY",
};
export class FileSecretResolver implements SecretResolver {
  constructor(private readonly path: string) {}
  async resolve(reference: string) {
    const variable = references[reference];
    if (variable === undefined) throw new Error("unknown secret reference");
    const values = parse(await readFile(this.path));
    const value = values[variable];
    if (value === undefined || value.length < 16)
      throw new Error("secret unavailable");
    return value;
  }
}
