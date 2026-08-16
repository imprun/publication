import { createApp, type WindforceContext } from "windforce-client";
import {
  connectionLogin,
  connectionStatus,
  listCategories,
  mediaUpload,
  postDelete,
  postPrepare,
  postPublish,
  postUpdate,
} from "./actions.js";

const actions = {
  "connection.login": connectionLogin,
  "connection.status": connectionStatus,
  "metadata.categories": listCategories,
  "media.upload": mediaUpload,
  "post.prepare": postPrepare,
  "post.publish": postPublish,
  "post.update": postUpdate,
  "post.delete": postDelete,
} satisfies Record<string, (ctx: WindforceContext) => Promise<unknown>>;

export const main = createApp({ actions });
