const adminService = require("../services/admin.service");

async function listPendingDrivers(req, res, next) {
  try {
    const drivers = await adminService.listPendingDrivers();
    res.json({ drivers });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/drivers?status=AVAILABLE|ON_TRIP|OFF_DUTY
async function listDrivers(req, res, next) {
  try {
    const drivers = await adminService.listDrivers({ status: req.query.status });
    res.json({ drivers });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/drivers/:id/status   body: { status: "AVAILABLE" | "OFF_DUTY" }
async function setDriverStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ message: "status is required" });
    }

    const driverProfile = await adminService.setDriverStatus(id, status);
    res.json({ driverProfile });
  } catch (err) {
    next(err);
  }
}

async function approveDriver(req, res, next) {
  try {
    const { id } = req.params;
    const user = await adminService.approveDriver(id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

async function rejectDriver(req, res, next) {
  try {
    const { id } = req.params;
    await adminService.rejectDriver(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function updateUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ message: "role is required" });
    }

    const user = await adminService.updateUserRole(id, role);
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

async function listPendingTrips(req, res, next) {
  try {
    const trips = await adminService.listPendingTrips();
    res.json({ trips });
  } catch (err) {
    next(err);
  }
}

async function approveTrip(req, res, next) {
  try {
    const { id } = req.params;
    const trip = await adminService.approveTrip(id, req.user.sub);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

async function rejectTrip(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const trip = await adminService.rejectTrip(id, req.user.sub, reason);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPendingDrivers,
  listDrivers,
  setDriverStatus,
  approveDriver,
  rejectDriver,
  updateUserRole,
  listPendingTrips,
  approveTrip,
  rejectTrip,
};