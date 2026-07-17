# WordPress integration

The preferred installation uses Elementor Pro Custom Code and does not require a plugin.

## Elementor Pro Custom Code

Create a site-wide custom code entry at the end of the `body` element:

```html
<script
  src="https://the-well-rag-agent.vercel.app/widget.js?v=1"
  data-site="the-well"
  data-cfasync="false"
  async
></script>
```

Set its display condition to the entire site. Test on staging before publishing the same code in production.

## Plugin fallback

If Elementor Custom Code is unavailable, zip the `the-well-chat-widget` directory and install it through WordPress under **Plugins > Add New > Upload Plugin**. Activating it loads the same Vercel-hosted widget globally.

The plugin contains no API keys or chat logic. Updates to the assistant remain on Vercel.
