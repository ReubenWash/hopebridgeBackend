const { client } = require('../config/paypal')

async function verifyPayment(orderId) {
  try {
    const response = await client.orders.getOrder({
      id: orderId,
    })

    return response.result
  } catch (error) {
    console.error('PayPal verification failed:', error)
    throw error
  }
}

module.exports = { verifyPayment }