// Logic for public/checkout.html, kept in its own file so the page can run under a strict
// Content-Security-Policy (script-src 'self' https://checkout.razorpay.com — see app.js).
// As an inline <script> it was blocked by that same policy and the page never left
// "Loading payment…".

// Opened by the customer app via expo-web-browser's openAuthSessionAsync — not meant to
// be visited directly. All state (Razorpay order details, where to redirect back to)
// travels in the query string; nothing is stored server-side for this page.
var params = new URLSearchParams(window.location.search);
var key = params.get('key');
var orderId = params.get('order_id');
var amount = Number(params.get('amount'));
var currency = params.get('currency') || 'INR';
var name = params.get('name') || 'Yulo Stores';
var redirect = params.get('redirect') || '';

var statusEl = document.getElementById('status');

// redirect must be our own app's custom URL scheme — this page must never become an
// open redirect to an arbitrary attacker-supplied URL.
var redirectIsSafe = /^yulostores:\/\//i.test(redirect);

function goBack(extraParams) {
  if (!redirectIsSafe) {
    statusEl.textContent = 'Payment could not be completed. Please return to the app.';
    return;
  }
  var sep = redirect.indexOf('?') === -1 ? '?' : '&';
  window.location.href = redirect + sep + new URLSearchParams(extraParams).toString();
}

if (!key || !orderId || !amount || !Number.isFinite(amount) || amount <= 0 || !redirectIsSafe) {
  statusEl.textContent = 'This payment link is invalid or has expired.';
} else {
  statusEl.textContent = 'Opening payment…';

  var rzp = new Razorpay({
    key: key,
    order_id: orderId,
    amount: amount,
    currency: currency,
    name: name,
    handler: function (response) {
      goBack({
        status: 'success',
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
      });
    },
    modal: {
      ondismiss: function () {
        goBack({ status: 'cancelled' });
      },
    },
  });

  rzp.on('payment.failed', function () {
    goBack({ status: 'failed' });
  });

  rzp.open();
}
