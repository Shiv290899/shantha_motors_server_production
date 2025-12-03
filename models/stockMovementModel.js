const mongoose = require('mongoose')
const { Schema } = mongoose

const ACTIONS = ['add', 'transfer', 'return', 'invoice']

const normalizeKey = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]/g, '')

const stockMovementSchema = new Schema(
  {
    movementId: { type: String, unique: true, index: true },

    // Vehicle
    chassisNo: { type: String, trim: true, uppercase: true, index: true },
    company: { type: String, trim: true, index: true },
    model: { type: String, trim: true, index: true },
    variant: { type: String, trim: true, index: true },
    color: { type: String, trim: true },

    // Movement
    action: { type: String, enum: ACTIONS, required: true },
    targetBranch: { type: String, trim: true },
    returnTo: { type: String, trim: true },
    customerName: { type: String, trim: true },
    sourceBranch: { type: String, trim: true },
    transferStatus: { type: String, enum: ['pending', 'admitted', 'rejected', 'completed'], default: 'completed', index: true },

    // Normalized keys for faster, case-insensitive matching
    sourceBranchKey: { type: String, index: true },
    targetBranchKey: { type: String, index: true },

    // Meta
    notes: { type: String, trim: true },
    createdByName: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedByName: { type: String, trim: true },
    resolvedAt: { type: Date },
    timestamp: { type: Date, default: Date.now },
    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
)

stockMovementSchema.pre('save', function (next) {
  this.sourceBranchKey = normalizeKey(this.sourceBranch)
  this.targetBranchKey = normalizeKey(this.targetBranch)
  next()
})

stockMovementSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    ret.id = ret._id
    delete ret._id
    delete ret.__v
    return ret
  },
})

const StockMovement = mongoose.model('StockMovement', stockMovementSchema)
module.exports = StockMovement
