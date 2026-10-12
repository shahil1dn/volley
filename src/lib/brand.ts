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
	 * null to show the name as text. Shown 32px tall on phones, larger on the
	 * projector; its alt text is `name`.
	 */
	logo: string | null;
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
	fonts: {
		body: SYSTEM_FONTS,
		display: SYSTEM_FONTS,
		displayWeight: 700,
		files: [],
	},
};
