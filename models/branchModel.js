const mongoose = require('mongoose')

const { Schema } = mongoose

const BRANCH_TYPE_OPTIONS = ['sales', 'service', 'sales & services']
const BRANCH_STATUS_OPTIONS = ['active', 'inactive', 'under_maintenance']

const branchSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: BRANCH_TYPE_OPTIONS, required: true, default: 'sales & services' },

    // Contact
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    // Address
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      area: { type: String, trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },

    // GeoJSON location: [lng, lat]
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: function (v) {
            return !v || v.length === 2
          },
          message: 'location.coordinates must be [lng, lat]',
        },
      },
    },

    status: { type: String, enum: BRANCH_STATUS_OPTIONS, default: 'active' },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
)

// Indexes
branchSchema.index({ code: 1 }, { unique: true })
branchSchema.index({ 'address.city': 1, type: 1 })
branchSchema.index({ location: '2dsphere' })

// Clean JSON output (hide internal fields)
branchSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id
    delete ret._id
    delete ret.__v
    return ret
  },
})

const Branch = mongoose.model('Branch', branchSchema)

module.exports = Branch

