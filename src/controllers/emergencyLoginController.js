const jwt = require('jsonwebtoken')

// Don't require User model here - we'll pass it as a parameter
module.exports = (User) => {
  return async (req, res) => {
    try {
      const { email, password } = req.body
      
      if (!email || !password) {
        return res.status(400).json({ message: 'Email and password required' })
      }
      
      // Find admin user with password field
      const user = await User.findOne({ email, role: 'admin' }).select('+password')
      
      if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' })
      }
      
      // Check if user is active
      if (user.active === false) {
        return res.status(401).json({ message: 'Account is disabled' })
      }
      
      // Verify password
      const bcrypt = require('bcrypt')
      const isPasswordValid = await bcrypt.compare(password, user.password)
      
      if (!isPasswordValid) {
        return res.status(401).json({ message: 'Invalid credentials' })
      }
      
      // Generate JWT token
      const token = jwt.sign(
        { id: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      )
      
      // Return user data
      const userData = {
        id: user._id,
        email: user.email,
        role: user.role,
        name: user.name,
        active: user.active
      }
      
      res.json({
        success: true,
        token,
        user: userData,
        message: 'Emergency login successful'
      })
      
    } catch (error) {
      console.error('Emergency login error:', error)
      res.status(500).json({ message: 'Server error during emergency login' })
    }
  }
}