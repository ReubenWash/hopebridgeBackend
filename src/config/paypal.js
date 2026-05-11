const { PayPalServerSdkClient, Environment } = require("@paypal/paypal-server-sdk");

const client = new PayPalServerSdkClient({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_SECRET,
  },
  environment: Environment.Sandbox, // change to Live in production
});

module.exports = { client };