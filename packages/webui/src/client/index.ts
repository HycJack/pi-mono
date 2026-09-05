import { mount } from "./ui/index.ts";

const root = document.getElementById("app");
if (root === null) throw new Error("#app element is missing");
mount(root);
