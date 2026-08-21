<?php
/*
Plugin Name: Linky Live — URL Helper
Description: Tells the live link gateway which local host to rewrite, and points WordPress's generated URLs at the public address.
Version: 2.0.0
Author: cartpauj
License: GPLv3 or later
*/

/**
 * Makes a Local site work correctly when reached through a live link, without
 * changing anything in the database.
 *
 * WordPress keeps believing it lives at its local address. That is deliberate and
 * it is what keeps three things working that a database swap breaks:
 *
 *   - Local's one-click admin login, which sets its session cookie on the local
 *     domain and cannot follow a cross-domain redirect
 *   - WordPress's own loopback HTTP requests, which would otherwise travel out to
 *     Cloudflare and back through a two-worker PHP pool and deadlock
 *   - browsing the site at its .local address while a link is on
 *
 * Two things then have to happen for a tunnelled request:
 *
 *   1. URLs that WordPress generates are pointed at the public host here.
 *   2. Anything this misses — most importantly URLs hardcoded in post content —
 *      is caught by the gateway, which rewrites the response body. It needs to be
 *      told what to look for, which is what the X-Local-Host header is for.
 *
 * None of these filters are registered unless the request arrived through the
 * gateway, so local browsing is completely unaffected.
 */

class Linky_Live_Urls {

	/** @var string Public hostname this request arrived on. */
	private $tunnel_host;

	/** @var string Host and port this site is actually served on locally. */
	private $local_host;

	public function __construct( $tunnel_host ) {
		$this->tunnel_host = $tunnel_host;
		$this->local_host  = $this->detect_local_host();

		$this->fix_server_vars();
		$this->add_filters();
	}

	/**
	 * Decide whether this request came through our gateway.
	 *
	 * Requires the marker the gateway always sets, so a stray local request cannot
	 * trigger rewriting by sending one header, and so this never fights Local's
	 * own built-in Live Links.
	 */
	public static function tunnel_host() {
		if ( empty( $_SERVER['HTTP_X_ORIGINAL_HOST'] ) || empty( $_SERVER['HTTP_X_LINKY_LIVE'] ) ) {
			return '';
		}

		return (string) preg_replace( '/[^A-Za-z0-9\.\-]/', '', (string) $_SERVER['HTTP_X_ORIGINAL_HOST'] );
	}

	/**
	 * Work out the host:port this site answers on locally.
	 *
	 * Read before fix_server_vars() rewrites SERVER_PORT, and the port is kept
	 * because Local's localhost routing mode serves every site on its own port —
	 * dropping it would leave the port stranded on rewritten URLs.
	 */
	private function detect_local_host() {
		$home = parse_url( (string) get_option( 'home' ) );

		if ( ! empty( $home['host'] ) ) {
			return $home['host'] . ( isset( $home['port'] ) ? ':' . $home['port'] : '' );
		}

		$host = isset( $_SERVER['SERVER_NAME'] ) ? (string) $_SERVER['SERVER_NAME'] : 'localhost';
		$port = isset( $_SERVER['SERVER_PORT'] ) ? (string) $_SERVER['SERVER_PORT'] : '';

		if ( '' !== $port && ! in_array( $port, array( '80', '443' ), true ) ) {
			$host .= ':' . $port;
		}

		return $host;
	}

	/**
	 * TLS terminates at the Cloudflare edge, so PHP sees a plain HTTP request.
	 * Without correcting this WordPress builds http:// URLs for an https:// site
	 * and canonical redirects bounce in a loop.
	 */
	private function fix_server_vars() {
		if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && 'https' === $_SERVER['HTTP_X_FORWARDED_PROTO'] ) {
			$_SERVER['HTTPS']       = 'on';
			$_SERVER['SERVER_PORT'] = '443';
		}

		$_SERVER['HTTP_HOST'] = $this->tunnel_host;
	}

	private function add_filters() {
		add_action( 'send_headers', array( $this, 'send_headers' ), PHP_INT_MAX );

		// Otherwise WordPress redirects the visitor back to the local hostname.
		remove_action( 'template_redirect', 'redirect_canonical' );

		$url_filters = array(
			'option_siteurl',
			'option_home',
			'blog_option_siteurl',
			'site_option_siteurl',
			'home_url',
			'site_url',
			'admin_url',
			'get_admin_url',
			'network_admin_url',
			'network_home_url',
			'network_site_url',
			'includes_url',
			'plugins_url',
			'content_url',
			'get_rest_url',
			'wp_redirect',
			'bloginfo_url',
			'the_permalink',
			'post_link',
			'page_link',
			'post_type_link',
			'attachment_link',
			'post_type_archive_link',
			'term_link',
			'search_link',
			'day_link',
			'month_link',
			'year_link',
			'get_pagenum_link',
			'get_comments_pagenum_link',
			'get_comment_link',
			'get_shortlink',
			'the_author_posts_link',
			'get_the_author_url',
			'wp_get_attachment_url',
			'wp_get_attachment_thumb_url',
			'wp_login_url',
			'wp_logout_url',
			'wp_lostpassword_url',
			'get_stylesheet_uri',
			'get_locale_stylesheet_uri',
			'stylesheet_directory_uri',
			'template_directory_uri',
			'get_theme_root_uri',
			'theme_root_uri',
			'script_loader_src',
			'style_loader_src',
		);

		foreach ( $url_filters as $filter ) {
			add_filter( $filter, array( $this, 'to_tunnel' ) );
		}

		// Returns an array rather than a string, so it needs its own handler.
		add_filter( 'wp_get_attachment_image_src', array( $this, 'to_tunnel_image_src' ) );

		// Never let the public hostname be written into the database.
		add_filter( 'pre_update_option', array( $this, 'to_local' ) );
		add_filter( 'wp_insert_post_data', array( $this, 'to_local_in_post' ), PHP_INT_MAX );
	}

	/**
	 * X-Local-Host is what lets the gateway finish the job: it rewrites the
	 * response body, catching URLs hardcoded in post content that no filter here
	 * can reach.
	 */
	public function send_headers() {
		header( 'X-Local-Host: ' . $this->local_host );

		// A rewritten response is specific to this hostname; never let it be shared.
		header( 'Cache-Control: private, no-store' );
		header( 'X-Robots-Tag: noindex, nofollow, noarchive' );
	}

	private function swap( $from, $to, $subject ) {
		if ( ! is_string( $subject ) || '' === $from ) {
			return $subject;
		}

		return str_replace( array( 'www.' . $from, $from ), $to, $subject );
	}

	/** Local host -> public host, forcing https since the edge is TLS-only. */
	public function to_tunnel( $value ) {
		if ( ! is_string( $value ) ) {
			return $value;
		}

		$value = $this->swap( $this->local_host, $this->tunnel_host, $value );
		$value = str_replace( 'http://' . $this->tunnel_host, 'https://' . $this->tunnel_host, $value );

		// Belt and braces: never emit an explicit port on the public hostname.
		return preg_replace( '#(' . preg_quote( $this->tunnel_host, '#' ) . '):\d+#', '$1', $value );
	}

	public function to_tunnel_image_src( $image ) {
		if ( is_array( $image ) && isset( $image[0] ) ) {
			$image[0] = $this->to_tunnel( $image[0] );
		}

		return $image;
	}

	/** Public host -> local host, for anything on its way into the database. */
	public function to_local( $value ) {
		if ( is_string( $value ) ) {
			return $this->swap( $this->tunnel_host, $this->local_host, $value );
		}

		if ( is_array( $value ) || is_object( $value ) ) {
			$rewritten = $this->swap( $this->tunnel_host, $this->local_host, serialize( $value ) );
			$restored  = @unserialize( $rewritten );

			return false === $restored ? $value : $restored;
		}

		return $value;
	}

	public function to_local_in_post( $data ) {
		foreach ( array( 'post_content', 'post_excerpt' ) as $field ) {
			if ( isset( $data[ $field ] ) ) {
				$data[ $field ] = $this->to_local( $data[ $field ] );
			}
		}

		return $data;
	}
}

$linky_live_tunnel_host = Linky_Live_Urls::tunnel_host();

if ( '' !== $linky_live_tunnel_host ) {
	new Linky_Live_Urls( $linky_live_tunnel_host );
}
