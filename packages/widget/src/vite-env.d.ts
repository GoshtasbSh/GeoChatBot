/// <reference types="vite/client" />

declare module "*.css?inline" {
	const css: string;
	export default css;
}

declare module "*.md?raw" {
	const content: string;
	export default content;
}
