import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
	? process.env.NEXT_PUBLIC_SITE_URL
	: process.env.VERCEL_URL
		? `https://${process.env.VERCEL_URL}`
		: "http://localhost:3000";

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: "GeoChatBot — Spatial analysis in your browser",
	description:
		"Ask plain-English questions about your spatial data — in your browser. No backend. Files never leave your device. Drop-in or headless.",
	openGraph: {
		title: "GeoChatBot — browser-native AI agent for spatial data",
		description:
			"Zero backend. Your files never leave the browser. DuckDB-WASM spatial SQL + a plan-then-execute agent with a human approval gate.",
		images: [{ url: "/social-preview.png", width: 1280, height: 640 }],
	},
	twitter: {
		card: "summary_large_image",
		title: "GeoChatBot — browser-native AI agent for spatial data",
		description:
			"Zero backend. Your files never leave the browser. Ask spatial questions in plain English.",
		images: ["/social-preview.png"],
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body
				className={`${geistSans.variable} ${geistMono.variable} antialiased`}
			>
				{children}
			</body>
		</html>
	);
}
