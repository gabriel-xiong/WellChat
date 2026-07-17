<?php
/**
 * Plugin Name: The Well Chat Widget
 * Description: Loads The Well website assistant from its Vercel deployment.
 * Version: 1.0.0
 * Author: The Well Austin
 */

if (!defined('ABSPATH')) {
    exit;
}

function the_well_chat_widget_enqueue_script() {
    wp_enqueue_script(
        'the-well-chat-widget',
        'https://the-well-rag-agent.vercel.app/widget.js',
        array(),
        '1.0.0',
        true
    );
}
add_action('wp_enqueue_scripts', 'the_well_chat_widget_enqueue_script');

function the_well_chat_widget_script_attributes($tag, $handle) {
    if ('the-well-chat-widget' !== $handle) {
        return $tag;
    }

    return str_replace(
        '<script ',
        '<script data-cfasync="false" data-site="the-well" async ',
        $tag
    );
}
add_filter('script_loader_tag', 'the_well_chat_widget_script_attributes', 10, 2);
