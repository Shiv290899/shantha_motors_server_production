const mongoose = require('mongoose')
const { Schema } = mongoose

const normalizeKey = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]/g, '')

// Represents the current state/location of a chassis in inventory.
// Enforces unique chassis numbers across the entire inventory.
const stockSchema = new Schema(
  {
    // Vehicle identity (unique across entire inventory)
    chassisNo: { type: String, trim: true, uppercase: true, required: true, unique: true, index: true },

    // Vehicle details (copied from latest known movement that carried details)
    company: { type: String, trim: true, index: true },
    model: { type: String, trim: true, index: true },
    variant: { type: String, trim: true, index: true },
    color: { type: String, trim: true },

    // Current location branch (the branch where the stock is physically present)
    sourceBranch: { type: String, trim: true },
    sourceBranchKey: { type: String, index: true },

    // Previous branch before the most recent transfer (helpful for UI reverse-suggestion)
    lastSourceBranch: { type: String, trim: true },

    // Status of stock in inventory
    // in_stock: present in a branch
    // out: moved out due to return/invoice
    status: { type: String, enum: ['in_stock', 'out'], default: 'in_stock', index: true },

    // Linkage/meta
    lastMovementId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
)

stockSchema.pre('save', function (next) {
  this.sourceBranchKey = normalizeKey(this.sourceBranch)
  next()
})

stockSchema.set('toJSON', {
  virtuals: true,
  transform: function (_doc, ret) {
    ret.id = ret._id
    delete ret._id
    delete ret.__v
    return ret
  },
})

stockSchema.index({ status: 1, sourceBranchKey: 1 })
stockSchema.index({ company: 1, model: 1, variant: 1 })

const Stock = mongoose.model('Stock', stockSchema)
module.exports = Stock

