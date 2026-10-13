// Your copy's name, colours, logo and fonts: the one place to change them. They
// are read when the app is built, so redeploy after editing. `npm test` checks the
// colours still pass WCAG AA contrast and says which pair fails if not.
export type Brand = {
	/** Shown at the top of every screen (when there is no logo) and in browser tab titles. */
	name: string;
	colours: {
		/** Buttons, focus rings, the most popular word and the poll bars. */
		accent: string;
		/** Text. The softer greys and the lines are mixed from this and `paper`. */
		ink: string;
		/** The page background. */
		paper: string;
	};
	/**
	 * A file in `static/`, as a path from the site's root (e.g. '/logo.svg'), or
	 * null to show the name as text. Its alt text is `name`.
	 */
	logo: string | null;
	/** The logo's height on phones, in px (16 to 96). The projector scales it by the same amount. */
	logoHeight: number;
	/**
	 * The thank-you slide. `message` fills in the slide's text in the session
	 * builder (the host can change it). `link`, if not null, is an https address
	 * shown as a QR code on the projector, such as your website.
	 */
	thankYou: { message: string; link: string | null };
	fonts: {
		/** Body text: a CSS font-family list. */
		body: string;
		/** Page headings: a CSS font-family list. */
		display: string;
		/** The weight headings use. Match a weight the display font has, or the browser fakes it. */
		displayWeight: number;
		/**
		 * Font files in `static/` to load, or [] when the fonts are already on every
		 * device. Check the font's licence lets you self-host it and keep it in your
		 * repository: many free fonts don't.
		 */
		files: { family: string; src: string; weight?: number }[];
	};
};

const SYSTEM_FONTS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const brand: Brand = {
	name: 'Volley',
	colours: {
		accent: '#0e6f64',
		ink: '#17191c',
		paper: '#ffffff',
	},
	logo: null,
	logoHeight: 32,
	thankYou: { message: 'Thank you for joining', link: null },
	fonts: {
		body: SYSTEM_FONTS,
		display: SYSTEM_FONTS,
		displayWeight: 700,
		files: [],
	},
};
