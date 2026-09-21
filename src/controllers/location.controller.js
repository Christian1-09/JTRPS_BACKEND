const locationService = require("../services/location.service");

// GET /api/admin/locations?status=active|inactive
async function listLocations(req, res, next) {
  try {
    const locations = await locationService.listLocations({ status: req.query.status });
    res.json({ locations });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/locations/:id
async function getLocation(req, res, next) {
  try {
    const location = await locationService.getLocation(req.params.id);
    res.json({ location });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/locations   body: { name, travelMinutes }
async function createLocation(req, res, next) {
  try {
    const { name, travelMinutes } = req.body;
    const location = await locationService.createLocation({ name, travelMinutes });
    res.status(201).json({ location });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/locations/:id   body: any of { name, travelMinutes, isActive }
async function updateLocation(req, res, next) {
  try {
    const { name, travelMinutes, isActive } = req.body;
    const location = await locationService.updateLocation(req.params.id, {
      name,
      travelMinutes,
      isActive,
    });
    res.json({ location });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin/locations/:id
async function deleteLocation(req, res, next) {
  try {
    await locationService.deleteLocation(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
};