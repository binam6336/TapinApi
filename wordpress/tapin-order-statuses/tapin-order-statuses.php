<?php
/**
 * Plugin Name: Tapin Order Statuses
 * Description: Registers custom WooCommerce order statuses created through TapinApi.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 */

defined('ABSPATH') || exit;

const TAPIN_ORDER_STATUS_TAXONOMY = 'tapin_order_status';

add_action('before_woocommerce_init', static function (): void {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
    }
});

add_action('init', static function (): void {
    if (!function_exists('wc_get_order_statuses')) return;
    register_taxonomy(TAPIN_ORDER_STATUS_TAXONOMY, [], ['public' => false, 'rewrite' => false]);
    foreach (tapin_order_status_terms() as $term) {
        $key = 'wc-' . $term->slug;
        if (get_post_status_object($key)) continue;
        $countLabel = str_replace('%', '%%', esc_html($term->name)) . ' <span class="count">(%s)</span>';
        register_post_status($key, [
            'label' => $term->name,
            'public' => false,
            'internal' => false,
            'exclude_from_search' => false,
            'show_in_admin_all_list' => true,
            'show_in_admin_status_list' => true,
            'label_count' => _n_noop($countLabel, $countLabel),
        ]);
    }
}, 20);

function tapin_order_status_terms(): array {
    $terms = get_terms(['taxonomy' => TAPIN_ORDER_STATUS_TAXONOMY, 'hide_empty' => false]);
    return is_array($terms) ? $terms : [];
}

add_filter('wc_order_statuses', static function (array $statuses): array {
    foreach (tapin_order_status_terms() as $term) {
        $statuses['wc-' . $term->slug] ??= $term->name;
    }
    return $statuses;
});

add_action('rest_api_init', static function (): void {
    if (!taxonomy_exists(TAPIN_ORDER_STATUS_TAXONOMY)) return;
    register_rest_route('wc/v3', '/tapin/order-statuses', [
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => static fn(): bool => current_user_can('edit_shop_orders'),
        'callback' => static function (): WP_REST_Response {
            $statuses = [];
            foreach (wc_get_order_statuses() as $key => $label) {
                $statuses[] = ['slug' => substr($key, 3), 'name' => $label];
            }
            return new WP_REST_Response($statuses, 200);
        },
    ]);
    register_rest_route('wc/v3', '/tapin/order-statuses', [
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => static function () {
            return current_user_can('manage_woocommerce') ?: new WP_Error(
                'tapin_status_forbidden', 'Managing WooCommerce is required.', ['status' => rest_authorization_required_code()]
            );
        },
        'args' => [
            'slug' => [
                'required' => true, 'type' => 'string', 'pattern' => '^[a-z][a-z0-9-]{0,16}$',
            ],
            'name' => [
                'required' => true, 'type' => 'string', 'maxLength' => 80, 'sanitize_callback' => 'sanitize_text_field',
            ],
        ],
        'callback' => static function (WP_REST_Request $request) {
            $slug = $request['slug'];
            $name = trim($request['name']);
            $key = 'wc-' . $slug;
            if ($name === '' || !preg_match('/^[a-z][a-z0-9-]{0,16}$/D', $slug) ||
                str_starts_with($slug, 'wc-') || in_array($slug, ['any', 'trash', 'auto-draft', 'checkout-draft'], true)) {
                return new WP_Error('tapin_status_invalid', 'Invalid order status slug or label.', ['status' => 400]);
            }
            if (isset(wc_get_order_statuses()[$key]) || get_post_status_object($key)) {
                return new WP_Error('tapin_status_exists', 'This order status already exists.', ['status' => 409]);
            }
            $result = wp_insert_term($name, TAPIN_ORDER_STATUS_TAXONOMY, ['slug' => $slug]);
            if (is_wp_error($result)) {
                $status = $result->get_error_code() === 'term_exists' ? 409 : 500;
                return new WP_Error('tapin_status_save_failed', $result->get_error_message(), ['status' => $status]);
            }
            $term = get_term($result['term_id'], TAPIN_ORDER_STATUS_TAXONOMY);
            if (!$term || is_wp_error($term)) {
                return new WP_Error('tapin_status_unavailable', 'Reload the status list to verify the result.', ['status' => 500]);
            }
            return new WP_REST_Response(['slug' => $term->slug, 'name' => $term->name], 201);
        },
    ]);
});
