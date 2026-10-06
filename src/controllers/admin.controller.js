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


// GET /api/admin/trips
// query: status, departmentId, search, from, to, printed, limit, offset
async function listAllTrips(req, res, next) {
  try {
    const result = await adminService.listAllTrips(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/vehicles/:id/status   body: { status }
async function setVehicleStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: "status is required" });
    }
    const result = await adminService.setVehicleStatus(req.params.id, status);
    res.json(result);
  } catch (err) {
    next(err);
  }
}


// PATCH /api/admin/vehicles/:id
async function updateVehicle(req, res, next) {
  try {
    const vehicle = await adminService.updateVehicle(req.params.id, req.body);
    res.json({ vehicle });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin/vehicles/:id
async function deleteVehicle(req, res, next) {
  try {
    await adminService.deleteVehicle(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
async function setVehicleDrivers(req, res, next) {
  try {
    const drivers = await adminService.setVehicleDrivers(
      req.params.id,
      req.body.assignments
    );
    res.json({ drivers });
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
  listAllTrips,
  approveTrip,
  rejectTrip,
  setVehicleStatus,
  updateVehicle,
  deleteVehicle,
  setVehicleDrivers
};