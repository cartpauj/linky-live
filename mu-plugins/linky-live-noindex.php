<?php
/*
Plugin Name: Linky Live — Force Noindex
Description: Forces the "Discourage search engines" option on and prevents it from being turned off.
Version: 1.0.0
Author: cartpauj
License: GPLv3 or later
*/

/**
 * These sites become publicly reachable over a tunnel, so indexing is forced off
 * at runtime rather than merely set once in the database.
 *
 * Filtering the option means it cannot be defeated from Settings > Reading, and
 * it stays correct even if a plugin, import, or database restore writes a 1.
 * The Reading screen reads the same filtered value, so its checkbox displays as
 * checked and does not contradict actual behaviour.
 */

add_filter( 'pre_option_blog_public', 'linky_live_force_blog_private', PHP_INT_MAX );
add_filter( 'option_blog_public', 'linky_live_force_blog_private', PHP_INT_MAX );

/**
 * Refuse writes as well, so the stored value never drifts from the enforced one.
 */
add_filter( 'pre_update_option_blog_public', 'linky_live_force_blog_private', PHP_INT_MAX );

function linky_live_force_blog_private() {
	return '0';
}

/**
 * Belt and braces for anything that emits robots directives without consulting
 * blog_public.
 */
add_filter(
	'wp_robots',
	function ( $robots ) {
		$robots['noindex']   = true;
		$robots['nofollow']  = true;
		$robots['noarchive'] = true;

		unset( $robots['index'], $robots['follow'] );

		return $robots;
	},
	PHP_INT_MAX
);
