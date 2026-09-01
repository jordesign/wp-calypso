/**
 * @jest-environment jsdom
 */
import { editorNavigate, editorNavigateCallback } from '../callback';
import type { EditorNavigateIO } from '../callback';

const navigate = jest.fn().mockResolvedValue( undefined );

function createIO( overrides: Partial< EditorNavigateIO > = {} ) {
	return {
		saveEverything: jest.fn().mockResolvedValue( undefined ),
		getHistory: jest.fn().mockReturnValue( { navigate } ),
		waitForPost: jest.fn().mockResolvedValue( true ),
		closeCommandPalette: jest.fn(),
		getPostContentClientId: jest.fn().mockReturnValue( 'departing-block' ),
		restorePostContentEditing: jest.fn().mockResolvedValue( undefined ),
		refreshNavigationBlocks: jest.fn().mockResolvedValue( 2 ),
		navigateWholePage: jest.fn(),
		...overrides,
	} as jest.Mocked< EditorNavigateIO >;
}

beforeEach( () => {
	jest.clearAllMocks();
} );

describe( 'editorNavigate', () => {
	it( 'saves, navigates, and reports the arrival once the editor has the page', async () => {
		const io = createIO();

		const result = await editorNavigate( io, { path: '/page/123' } );

		expect( io.saveEverything ).toHaveBeenCalled();
		expect( navigate ).toHaveBeenCalledWith( '/page/123?canvas=edit' );
		expect( io.waitForPost ).toHaveBeenCalledWith( 123 );
		// Restored against the block being left, so the wait cannot settle on
		// the departing page's tree.
		expect( io.restorePostContentEditing ).toHaveBeenCalledWith( 'departing-block' );
		expect( io.closeCommandPalette ).toHaveBeenCalled();
		expect( result.result.error ).toBeUndefined();
		expect( result ).toMatchObject( {
			result: { success: true, details: { path: '/page/123', refreshedNavigationBlocks: 0 } },
			returnToAgent: true,
		} );
	} );

	it( 'saves before navigating, so pending edits are not lost', async () => {
		const order: string[] = [];
		const io = createIO( {
			saveEverything: jest.fn( async () => {
				order.push( 'save' );
			} ),
			getHistory: jest
				.fn()
				.mockReturnValue( { navigate: jest.fn( async () => void order.push( 'navigate' ) ) } ),
		} );

		await editorNavigate( io, { path: '/page/123' } );

		expect( order ).toEqual( [ 'save', 'navigate' ] );
	} );

	it( 'opens the pages list for all-pages, with no page to wait for', async () => {
		const io = createIO();

		const result = await editorNavigate( io, { path: 'all-pages' } );

		// A route with no canvas and no post entity behind it.
		expect( navigate ).toHaveBeenCalledWith( '/page' );
		expect( io.waitForPost ).not.toHaveBeenCalled();
		expect( io.restorePostContentEditing ).not.toHaveBeenCalled();
		expect( result.result.success ).toBe( true );
	} );

	it.each( [
		[ 'a slug', '/page/about' ],
		[ 'a full URL', 'https://example.com/page/12' ],
		[ 'an unrelated route', '/visit' ],
		// `Number` would rewrite these, but the canvas guard binds the raw
		// text — so they must not be accepted at all.
		[ 'a leading-zero id', '/page/00123' ],
		[ 'an id past MAX_SAFE_INTEGER', '/page/90071992547409911' ],
		[ 'a missing path', undefined ],
	] )( 'refuses %s without saving or navigating', async ( _case, path ) => {
		const io = createIO();

		const result = await editorNavigate( io, { path } );

		expect( result.result.success ).toBe( false );
		expect( io.saveEverything ).not.toHaveBeenCalled();
		expect( io.navigateWholePage ).not.toHaveBeenCalled();
	} );

	it( 'refuses to report success when the editor never loads the page', async () => {
		const io = createIO( { waitForPost: jest.fn().mockResolvedValue( false ) } );

		const result = await editorNavigate( io, { path: '/page/7' } );

		expect( result.result.success ).toBe( false );
		expect( result.result.error ).toContain( 'did not finish loading' );
		// The backend echoes `message` to the user, so the agent instruction
		// must stay in `error` — the raw-text bug this split fixed.
		expect( result.result.message ).toBe( 'That page did not finish opening.' );
		// The agent must not edit a page the editor may not be showing.
		expect( io.restorePostContentEditing ).not.toHaveBeenCalled();
		expect( io.refreshNavigationBlocks ).not.toHaveBeenCalled();
	} );

	it( 'falls back to a whole-page load when there is no router', async () => {
		const io = createIO( { getHistory: jest.fn().mockReturnValue( undefined ) } );

		const result = await editorNavigate( io, { path: '/page/9' } );

		expect( io.saveEverything ).toHaveBeenCalled();
		expect( io.navigateWholePage ).toHaveBeenCalledWith(
			'/wp-admin/site-editor.php?p=%2Fpage%2F9&canvas=edit'
		);
		expect( result.result.details ).toMatchObject( { path: '/page/9', fullPageLoad: true } );
		// The backend acks this tool from the envelope, so the result must be
		// delivered — the navigation waits for the stream to close.
		expect( result.returnToAgent ).toBe( true );
		expect( io.waitForPost ).not.toHaveBeenCalled();
	} );

	it( 'omits the canvas from a whole-page load of the pages list', async () => {
		const io = createIO( { getHistory: jest.fn().mockReturnValue( undefined ) } );

		await editorNavigate( io, { path: 'all-pages' } );

		expect( io.navigateWholePage ).toHaveBeenCalledWith( '/wp-admin/site-editor.php?p=%2Fpage' );
	} );

	it.each( [ 'page/123', '/page/123', '/page/123/' ] )(
		'normalizes %s to the canonical path',
		async ( path ) => {
			const io = createIO();

			const result = await editorNavigate( io, { path } );

			expect( navigate ).toHaveBeenCalledWith( '/page/123?canvas=edit' );
			expect( result.result.details ).toMatchObject( { path: '/page/123' } );
		}
	);

	it( 'refreshes navigation blocks only when asked, and reports how many', async () => {
		const io = createIO();

		const withRefresh = await editorNavigate( io, {
			path: '/page/123',
			refresh_navigation: true,
		} );

		expect( io.refreshNavigationBlocks ).toHaveBeenCalled();
		expect( withRefresh.result.details ).toMatchObject( {
			refreshNavigation: true,
			refreshedNavigationBlocks: 2,
		} );
	} );

	it( 'prefers the agent’s own summary as the message', async () => {
		const io = createIO();

		const result = await editorNavigate( io, {
			path: '/page/5',
			summary: 'Opened the About page.',
		} );

		expect( result.result.message ).toBe( 'Opened the About page.' );
	} );

	it( 'reports a failed save as an error instead of claiming arrival', async () => {
		const io = createIO( {
			saveEverything: jest.fn().mockRejectedValue( new Error( 'save failed' ) ),
		} );

		const result = await editorNavigate( io, { path: '/page/3' } );

		expect( result.result.success ).toBe( false );
		expect( result.result.error ).toContain( 'save failed' );
	} );
} );

describe( 'editorNavigateCallback', () => {
	it( 'refuses to navigate when the editor is not open', async () => {
		const result = await editorNavigateCallback( { path: '/page/123' } );

		expect( result.result.success ).toBe( false );
		expect( result.result.error ).toContain( 'editor is not open' );
	} );
} );
