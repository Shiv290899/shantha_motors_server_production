const mongoose = require('mongoose')

const { Schema } = mongoose

// Centralized role and status options (kept lowercase for consistency)
// Aligned with roles used in client components (Navbar, routes):
// - admin → /admin
// - owner → /admin (owner-level access)
// - mechanic → /mechanic
// - staff → /staff
// - employees → /employees
const ROLE_OPTIONS = [
  'admin',
  'mechanic',
  'staff',
  'employees',
  'owner',
  'user', // fallback/basic role
]

const STATUS_OPTIONS = ['active', 'inactive', 'suspended']

const userSchema = new Schema(
  {
    // Identity
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    phone: { type: String, unique: true, sparse: true, trim: true }, // optional but unique when present

    // Auth (password is already hashed in route; do not hash here again)
    password: { type: String, required: true },

    // Employment / Access control
    role: {
      type: String,
      enum: ROLE_OPTIONS,
      required: true,
      default: 'user', // change to 'staff' if you want branch users by default
    },
    jobTitle: { type: String },
    employeeCode: { type: String }, // unique within a primary branch

    // Branch association
    primaryBranch: { type: Schema.Types.ObjectId, ref: 'Branch' },
    branches: [{ type: Schema.Types.ObjectId, ref: 'Branch' }], // optional multi-branch support

    // Operational
    status: { type: String, enum: STATUS_OPTIONS, default: 'active' },
    lastLoginAt: { type: Date },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
)

// Indexes
userSchema.index({ primaryBranch: 1 })
userSchema.index({ role: 1 })
// Ensure employeeCode is unique within a primary branch (when both exist)
userSchema.index(
  { employeeCode: 1, primaryBranch: 1 },
  {
    unique: true,
    partialFilterExpression: {
      employeeCode: { $type: 'string' },
      primaryBranch: { $type: 'objectId' },
    },
  }
)

// Clean JSON output (hide internal fields)
userSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id
    delete ret._id
    delete ret.__v
    // Do not delete password here, login route expects it when fetched directly.
    return ret
  },
})

const User = mongoose.model('User', userSchema)

module.exports = User
