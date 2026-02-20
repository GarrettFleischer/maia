import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import {
  credentialCreate,
  credentialUpdate,
  credentialDelete,
  credentialList,
} from "../security/credential-vault";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

export const credentialCreateTool = makeTool(
  "credential_create",
  "Store a new credential (key/value). The value is encrypted and never revealed to you again.",
  z.object({ key: z.string(), value: z.string() }),
  async ({ key, value }) => { credentialCreate(key, value); }
);

export const credentialUpdateTool = makeTool(
  "credential_update",
  "Update the value of an existing credential.",
  z.object({ key: z.string(), value: z.string() }),
  async ({ key, value }) => { credentialUpdate(key, value); }
);

export const credentialDeleteTool = makeTool(
  "credential_delete",
  "Delete a credential by key.",
  z.object({ key: z.string() }),
  async ({ key }) => { credentialDelete(key); }
);

export const credentialListTool = makeTool(
  "credential_list",
  "List all stored credential keys (values are never returned).",
  z.object({}),
  async () => credentialList()
);

export const credentialTools: Tool[] = [
  credentialCreateTool,
  credentialUpdateTool,
  credentialDeleteTool,
  credentialListTool,
];
