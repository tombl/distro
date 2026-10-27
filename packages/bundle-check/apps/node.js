// A host directory on its own.
import { NodeFS } from "lowland/node";

export const fs = new NodeFS(".");
