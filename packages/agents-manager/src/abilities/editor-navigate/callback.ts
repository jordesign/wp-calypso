import { store as coreStore } from '@wordpress/core-data';
import { dispatch, resolveSelect, select } from '@wordpress/data';
import { __, sprintf } from '@wordpress/i18n';
import { getEditorHistory, type EditorHistory } from '../../utils/editor-history';
import { isEditorPage } from '../../utils/is-editor-page';
import { waitForStore } from '../../utils/wait-for-store';
import { errorResult, successResult } from '../ability-result';
import { PAGE_PATH } from './page-path';
import type { AbilityResult } from '../types';

// The two navigable targets: one page, or the pages list. Big Sky's copy
// rejected `all-pages`, but the backend has always documented it for this
// tool id — see `ability.editor-navigate.php`'s model instructions.
const PAGES_LIST_PATH = 'all-pages';
const PAGES_LIST_ROUTE = '/page';

// `history.navigate()` resolves on the route change, not on the editor loading
// the page — until it does, reads and edits hit the departed one.
const EDITOR_LOAD_TIMEOUT_MS = 5000;

// The destination's blocks arrive with its render, not with its post entity.
const NAVIGATION_REFS_TIMEOUT_MS = 1500;

// Lets this turn's stream close before the page unloads.
const UNLOAD_DELAY_MS = 1000;

interface Block {
	attributes?: Record< string, unknown >;
}

// `select`/`dispatch` by store name are untyped, so each store's shape is
// declared once here rather than at every call site.
interface CoreSelectors {
	__experimentalGetDirtyEntityRecords?: () => { kind: string; name: string; key: string }[];
}
interface CoreActions {
	saveEditedEntityRecord: (
		kind: string,
		name: string,
		key: string,
		options?: { throwOnError?: boolean }
	) => Promise< unknown >;
	invalidateResolution?: ( selector: string, args: unknown[] ) => void;
}
interface BlockEditorSelectors {
	getBlock?: ( clientId: string ) => Block | null;
	getBlocksByName?: ( name: string ) => string[];
	getBlockEditingMode?: ( clientId: string ) => string | undefined;
}

const coreSelect = () => select( coreStore ) as unknown as CoreSelectors;
const coreDispatch = () => dispatch( coreStore ) as unknown as CoreActions;
const blockEditorSelect = () => select( 'core/block-editor' ) as unknown as BlockEditorSelectors;

export interface EditorNavigateInput {
	path?: string;
	refresh_navigation?: boolean;
	summary?: string;
}

export interface EditorNavigateIO {
	/** Saves every dirty entity, so nothing is lost when the route changes. */
	saveEverything: () => Promise< void >;
	/** The site editor's router history, or undefined outside the site editor. */
	getHistory: () => EditorHistory | undefined;
	/** Resolves true once the editor holds `postId`, false on timeout. */
	waitForPost: ( postId: number ) => Promise< boolean >;
	/** Closes the command palette, which stays open over the destination. */
	closeCommandPalette: () => void;
	/** The post-content block currently in the tree, if any. */
	getPostContentClientId: () => string | undefined;
	/**
	 * Re-enables editing on the destination's post-content block, waiting for
	 * it to replace `departingClientId` — the tree lags the route change.
	 */
	restorePostContentEditing: ( departingClientId: string | undefined ) => Promise< void >;
	/** Refreshes the destination's menus; returns how many were refreshed. */
	refreshNavigationBlocks: () => Promise< number >;
	/** Full-page fallback when the site editor's router is out of reach. */
	navigateWholePage: ( destination: string ) => void;
}

/**
 * The `editor-navigate` flow, with its editor access injected.
 */
export async function editorNavigate(
	io: EditorNavigateIO,
	{ path, refresh_navigation: refreshNavigation, summary }: EditorNavigateInput
): Promise< AbilityResult > {
	const isPagesList = path === PAGES_LIST_PATH;
	const postId = Number( PAGE_PATH.exec( path ?? '' )?.[ 1 ] );

	if ( ! isPagesList && ! postId ) {
		return errorResult(
			'Invalid editor path. Look up the numeric id from <site_pages>, then retry with /page/{id}.',
			__(
				'I need a page id to open that page. Page navigation uses /page/{id}.',
				__i18n_text_domain__
			)
		);
	}

	// The schema admits `page/12`, `/page/12` and a trailing slash alike.
	const editorPath = isPagesList ? PAGES_LIST_ROUTE : `/page/${ postId }`;

	// Read before the save: that awaits a network round trip per dirty entity,
	// and an unmounting chat would take the history with it.
	const history = io.getHistory();

	// Captured before the route changes, so the restore can tell the
	// destination's post-content block from the one being left behind.
	const departingPostContent = io.getPostContentClientId();

	try {
		await io.saveEverything();

		// Outside the site editor there is no router, so the browser loads it
		// itself — after this turn's stream closes, since the backend acks
		// this tool straight from the envelope.
		if ( ! history ) {
			io.navigateWholePage(
				`/wp-admin/site-editor.php?p=${ encodeURIComponent( editorPath ) }${
					isPagesList ? '' : '&canvas=edit'
				}`
			);

			return successResult(
				summary ||
					// translators: %s: the editor path being opened.
					sprintf( __( 'Opening %s…', __i18n_text_domain__ ), editorPath ),
				{ path: editorPath, fullPageLoad: true }
			);
		}

		// The list view is a route with no canvas, and no page to wait for.
		await history.navigate( isPagesList ? editorPath : `${ editorPath }?canvas=edit` );
		io.closeCommandPalette();

		if ( isPagesList ) {
			return successResult( summary || __( 'Opening the pages list.', __i18n_text_domain__ ), {
				path: editorPath,
			} );
		}

		if ( ! ( await io.waitForPost( postId ) ) ) {
			return errorResult(
				`Navigated to ${ editorPath }, but the editor did not finish loading that page in time. Do not edit content yet — the editor may still be showing the previous page. Tell the user the page did not open, and stop.`,
				__( 'That page did not finish opening.', __i18n_text_domain__ ),
				{ path: editorPath }
			);
		}

		// Switching pages leaves post-content editing disabled.
		await io.restorePostContentEditing( departingPostContent );

		const refreshedNavigationBlocks = refreshNavigation ? await io.refreshNavigationBlocks() : 0;

		return successResult(
			summary ||
				// translators: %s: the editor path that was opened.
				sprintf( __( 'Saved your changes and opened %s.', __i18n_text_domain__ ), editorPath ),
			{
				path: editorPath,
				refreshNavigation: Boolean( refreshNavigation ),
				refreshedNavigationBlocks,
			}
		);
	} catch ( error ) {
		return errorResult(
			`Failed to navigate to ${ editorPath }. Error: ${ ( error as Error ).message }`,
			__( 'I could not open that page.', __i18n_text_domain__ ),
			{ path: editorPath }
		);
	}
}

/** Saves every dirty entity record, the way the editor's own save does. */
async function saveEverything(): Promise< void > {
	const { saveEditedEntityRecord } = coreDispatch();

	for ( const { kind, name, key } of coreSelect().__experimentalGetDirtyEntityRecords?.() ?? [] ) {
		// Saves swallow their errors by default, and navigating then would
		// leave the edit behind.
		await saveEditedEntityRecord( kind, name, key, { throwOnError: true } );
	}
}

const getLoadedPostId = (): number =>
	Number(
		(
			select( 'core/editor' ) as unknown as { getCurrentPostId?: () => unknown }
		 )?.getCurrentPostId?.()
	);

/** Resolves once the editor reports `postId` as its current post. */
const waitForPost = ( postId: number ) =>
	waitForStore( 'core/editor', () => getLoadedPostId() === postId, EDITOR_LOAD_TIMEOUT_MS );

/** The distinct menus referenced by every navigation block in the tree. */
function getNavigationRefs(): unknown[] {
	const blockEditor = blockEditorSelect();

	return [
		...new Set(
			( blockEditor.getBlocksByName?.( 'core/navigation' ) ?? [] )
				.map( ( clientId ) => blockEditor.getBlock?.( clientId )?.attributes?.ref )
				.filter( Boolean )
		),
	];
}

/** Drops cached navigation records, so a page just added to a menu appears. */
async function refreshNavigationBlocks(): Promise< number > {
	const core = coreDispatch();
	const resolve = resolveSelect( coreStore ) as unknown as {
		getEditedEntityRecord: ( kind: string, name: string, key: unknown ) => Promise< unknown >;
	};

	// The destination's blocks settle after the route change, so the menus are
	// not in the tree on the first read.
	await waitForStore(
		'core/block-editor',
		() => getNavigationRefs().length > 0,
		NAVIGATION_REFS_TIMEOUT_MS
	);

	const refs = getNavigationRefs();

	let refreshed = 0;

	for ( const ref of refs ) {
		// Both selectors, because `getEditedEntityRecord`'s resolver forwards to
		// `getEntityRecord`: invalidating only the first would let the await
		// settle on the cached record instead of the refetch.
		for ( const selector of [ 'getEditedEntityRecord', 'getEntityRecord' ] ) {
			core.invalidateResolution?.( selector, [ 'postType', 'wp_navigation', ref ] );
		}

		try {
			await resolve.getEditedEntityRecord( 'postType', 'wp_navigation', ref );
			refreshed++;
		} catch {
			// A menu that fails to re-resolve keeps its cached copy.
		}
	}

	return refreshed;
}

const getPostContentClientId = (): string | undefined =>
	( blockEditorSelect().getBlocksByName?.( 'core/post-content' ) ?? [] )[ 0 ];

/**
 * Re-enables editing on the destination's post-content block, which switching
 * pages leaves disabled.
 */
async function restorePostContentEditing( departingClientId: string | undefined ): Promise< void > {
	// Two things have to be true before overriding, and both arrive late. The
	// block must be the destination's, not the page being left — the tree
	// lags the entity. And core's own effect must already have restricted it,
	// or it would run afterwards and undo this.
	//
	// A timeout is not an error: it means no post-content block, or one core
	// never restricted, and there is nothing to restore either way.
	await waitForStore(
		'core/block-editor',
		() => {
			const clientId = getPostContentClientId();
			return (
				Boolean( clientId ) &&
				clientId !== departingClientId &&
				blockEditorSelect().getBlockEditingMode?.( clientId as string ) !== 'default'
			);
		},
		EDITOR_LOAD_TIMEOUT_MS
	);

	const postContentClientId = getPostContentClientId();

	// An absent clientId would default to '', putting the editor root — core's
	// tree, not ours — into default mode.
	if ( ! postContentClientId ) {
		return;
	}

	const blockEditor = dispatch( 'core/block-editor' ) as unknown as {
		setBlockEditingMode?: ( clientId: string, mode: string ) => void;
		__unstableMarkNextChangeAsNotPersistent?: () => void;
	};

	// This is UI state, not an edit: core marks the same change non-persistent
	// so it stays out of the destination's undo history.
	blockEditor.__unstableMarkNextChangeAsNotPersistent?.();
	blockEditor.setBlockEditingMode?.( postContentClientId, 'default' );
}

/**
 * The `editor-navigate` ability callback.
 */
export async function editorNavigateCallback(
	input: EditorNavigateInput
): Promise< AbilityResult > {
	// Registration is editor-only, but ownership of the tool call is not, so
	// the guard travels with the write.
	if ( ! isEditorPage() ) {
		return errorResult(
			'The editor is not open, so there is no editor route to navigate.',
			__( 'I can only navigate from the editor.', __i18n_text_domain__ )
		);
	}

	return editorNavigate(
		{
			saveEverything,
			getHistory: getEditorHistory,
			waitForPost,
			closeCommandPalette: () =>
				( dispatch( 'core/commands' ) as unknown as { close?: () => void } )?.close?.(),
			getPostContentClientId,
			restorePostContentEditing,
			refreshNavigationBlocks,
			navigateWholePage: ( destination ) => {
				// After the turn's stream closes, so the result is delivered
				// before the page unloads.
				const startedAt = window.location.href;
				setTimeout( () => {
					// The user moved on during the delay; leave them there.
					if ( window.location.href === startedAt ) {
						window.location.href = destination;
					}
				}, UNLOAD_DELAY_MS );
			},
		},
		input
	);
}
