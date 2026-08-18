import { defineAction, defineApp, type RuntimeAccess } from "@imprun/app-sdk";
import {
  connectionDisconnect,
  connectionLogin,
  connectionStatus,
  listCategories,
  mediaUpload,
  postDelete,
  postPrepare,
  postPublish,
  postUpdate,
} from "./actions.js";

const connectionAccess = {
  variables: [{ scope: "actor", path: "connections/tistory/default/session" }],
  resources: [{ scope: "actor", path: "connections/tistory/default/profile" }],
} as const satisfies RuntimeAccess;

const loginAccess = {
  ...connectionAccess,
  variables: [
    ...connectionAccess.variables,
    { scope: "actor", path: "connections/tistory/default/account-id" },
    { scope: "actor", path: "connections/tistory/default/password" },
  ],
  writeVariables: [
    {
      scope: "actor",
      path: "connections/tistory/default/session",
      storage: "secret",
    },
    {
      scope: "actor",
      path: "connections/tistory/default/account-id",
      storage: "secret",
    },
    {
      scope: "actor",
      path: "connections/tistory/default/password",
      storage: "secret",
    },
  ],
  writeResources: [{ scope: "actor", path: "connections/tistory/default/profile" }],
} as const satisfies RuntimeAccess;

const disconnectAccess = {
  ...connectionAccess,
  writeVariables: [
    {
      scope: "actor",
      path: "connections/tistory/default/session",
      storage: "secret",
    },
    {
      scope: "actor",
      path: "connections/tistory/default/account-id",
      storage: "secret",
    },
    {
      scope: "actor",
      path: "connections/tistory/default/password",
      storage: "secret",
    },
  ],
} as const satisfies RuntimeAccess;

export const app = defineApp({
  name: "publication",
  entrypoint: "src/main.ts",
  timeout: 900,
  actions: [
    defineAction({
      name: "connection.login",
      inputSchema: { path: "schemas/connection.login.input.schema.json" },
      outputSchema: { path: "schemas/connection.output.schema.json" },
      runsOn: ["browser"],
      runtimeAccess: loginAccess,
      handler: connectionLogin,
    }),
    defineAction({
      name: "connection.disconnect",
      inputSchema: { path: "schemas/connection.input.schema.json" },
      outputSchema: { path: "schemas/connection.output.schema.json" },
      runtimeAccess: disconnectAccess,
      handler: connectionDisconnect,
    }),
    defineAction({
      name: "connection.status",
      inputSchema: { path: "schemas/connection.input.schema.json" },
      outputSchema: { path: "schemas/connection.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: connectionStatus,
    }),
    defineAction({
      name: "metadata.categories",
      inputSchema: { path: "schemas/connection.input.schema.json" },
      outputSchema: { path: "schemas/categories.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: listCategories,
    }),
    defineAction({
      name: "media.upload",
      inputSchema: { path: "schemas/media.upload.input.schema.json" },
      outputSchema: { path: "schemas/media.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: mediaUpload,
    }),
    defineAction({
      name: "post.prepare",
      inputSchema: { path: "schemas/post.prepare.input.schema.json" },
      outputSchema: { path: "schemas/post.prepare.output.schema.json" },
      handler: postPrepare,
    }),
    defineAction({
      name: "post.publish",
      inputSchema: { path: "schemas/post.publish.input.schema.json" },
      outputSchema: { path: "schemas/post.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: postPublish,
    }),
    defineAction({
      name: "post.update",
      inputSchema: { path: "schemas/post.update.input.schema.json" },
      outputSchema: { path: "schemas/post.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: postUpdate,
    }),
    defineAction({
      name: "post.delete",
      inputSchema: { path: "schemas/post.delete.input.schema.json" },
      outputSchema: { path: "schemas/post.delete.output.schema.json" },
      runtimeAccess: connectionAccess,
      handler: postDelete,
    }),
  ],
});

export const main = app.main;
