// The origin private file system on its own.
import { BrowserFS } from "lowland/browser";

export const fs = new BrowserFS(await navigator.storage.getDirectory());
